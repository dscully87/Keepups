/**
 * Authors the game's surface materials in MaterialCraft (github.com/storytold/
 * materialcraft) and bakes them to small tileable PNGs under assets/materials.
 *
 *   MATERIALCRAFT_CLI=/path/to/materialcraft-cli node tools/materials/build.mjs
 *
 * Each material is a real node graph, saved next to this script as an .sbs
 * package you can open and keep editing in the MaterialCraft app. The graphs
 * are built here through the CLI's JSON-lines channel: a Pixel Processor whose
 * per-pixel function is written with the little expression helpers below, then
 * MaterialCraft's own Normal / Levels / Blur nodes to derive the maps.
 *
 * The bake is a build step, not a runtime one: the game only ever loads the
 * PNGs, so nothing here ships to the phone.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = join(ROOT, 'assets/materials');
const CLI = process.env.MATERIALCRAFT_CLI || 'materialcraft-cli';

mkdirSync(OUT, { recursive: true });

/** One MaterialCraft engine session over stdio. */
class Session {
  constructor(cwd) {
    this.proc = spawn(CLI, ['serve', '--read-root', cwd, '--write-root', cwd], {
      cwd,
      env: { ...process.env, MATERIALCRAFT_NO_PREFS: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.pending = new Map();
    this.seq = 0;
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(`${p.what}: ${msg.error}`));
    });
  }

  call(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, what: `${method} ${JSON.stringify(params).slice(0, 160)}` });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  run(id, params = {}) {
    return this.call('command.run', { id, params });
  }

  close() {
    this.proc.stdin.end();
  }
}

/**
 * Expression helpers for a Pixel Processor function. Every helper adds one
 * function node and returns its id, so an expression reads inside-out the way
 * the graph is wired.
 */
function functionBuilder(session, node) {
  const target = { kind: 'parameter', node, parameter: 'function' };
  let column = 0;
  const edit = (e) => session.run('graph.function.edit', { target, edit: e });
  const add = async (operation, inputs = [], value) => {
    column += 1;
    const { id } = await edit({ action: 'add', operation, at: [column * 140, (column % 5) * 90] });
    if (value !== undefined) await edit({ action: 'value', id, value });
    for (let i = 0; i < inputs.length; i += 1) {
      await edit({ action: 'connect', from: (await inputs[i]).id, to: id, input: i });
    }
    // Wrapped, so a node reference can never be mistaken for a literal number.
    return { id };
  };
  const f = (v) => add('const_float1', [], { t: 'float', v });
  const lift = (x) => (typeof x === 'number' ? f(x) : x);
  const bin = (op) => (a, b) => add(op, [lift(a), lift(b)]);
  const un = (op) => (a) => add(op, [lift(a)]);
  const b = {
    f,
    pos: () => add('get_float2', [], { t: 'text', v: '$pos' }),
    x: (v) => add('swizzle1', [v], { t: 'int', v: 0 }),
    y: (v) => add('swizzle1', [v], { t: 'int', v: 1 }),
    vec2: (x, y) => add('vector2', [lift(x), lift(y)]),
    add: bin('add'),
    sub: bin('sub'),
    mul: bin('mul'),
    div: bin('div'),
    mod: bin('mod'),
    min: bin('min'),
    max: bin('max'),
    pow: bin('pow'),
    sin: un('sin'),
    cos: un('cos'),
    abs: un('abs'),
    floor: un('floor'),
    sqrt: un('sqrt'),
    rand: un('rand'),
    lerp: (a, c, t) => add('lerp', [lift(a), lift(c), lift(t)]),
    output: (ref) => Promise.resolve(ref).then((v) => edit({ action: 'output', id: v.id })),
  };
  b.fract = (a) => b.sub(a, b.floor(a));
  b.clamp01 = (a) => b.max(0, b.min(1, a));
  /** Hermite step between two constants. */
  b.smoothstep = async (lo, hi, v) => {
    const t = await b.clamp01(b.div(b.sub(v, lo), hi - lo));
    return b.mul(b.mul(t, t), b.sub(3, b.mul(2, t)));
  };
  return b;
}

/** Ids of the PBR template's source and output nodes, by output identifier. */
async function templatePorts(session) {
  const { graph } = await session.call('session.inspect', {});
  const ports = {};
  for (const n of graph.nodes) {
    if (n.def !== 'output') continue;
    const wire = graph.connections.find((c) => c.to === n.id);
    ports[n.params.identifier.v] = { output: n.id, source: wire?.from };
  }
  return ports;
}

async function bake(name, size, author) {
  const work = join(HERE, '.work', name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const session = new Session(work);
  try {
    await session.run('file.new', { name, template: 'pbr', size });
    const ports = await templatePorts(session);

    const pp = await session.run('graph.node.add', { def: 'pixel_processor', at: [-600, 0], params: { color_mode: false } });
    await author({
      session,
      ports,
      height: pp.id,
      fn: functionBuilder(session, pp.id),
      node: (def, from, params = {}, at = [0, 0]) =>
        session.run('graph.node.add', { def, at, params, connectFrom: { node: from } }).then((r) => r.id),
      route: (from, identifier) => session.run('graph.connect', { from, to: ports[identifier].output }),
      set: (identifier, color) =>
        session.run('graph.node.param', { id: ports[identifier].source, param: 'color', value: color }),
    });

    const cooked = await session.run('graph.cook', { full: true });
    const { graph } = await session.call('session.inspect', {});
    const errors = [
      ...(cooked?.nodes || []).filter((n) => n.error),
      ...graph.nodes.filter((n) => n.cooked?.error).map((n) => ({ id: n.id, def: n.def, error: n.cooked.error })),
      ...(graph.functionWarnings || []),
    ];
    if (errors.length) throw new Error(`${name}: ${JSON.stringify(errors)}`);

    await session.call('package.save', { path: `${name}.sbs` });
    await session.call('outputs.export', {
      dir: 'out',
      format: 'png',
      depth: 8,
      size,
      pattern: '$(identifier)',
      outputs: ['normal', 'roughness'],
    });
  } finally {
    session.close();
  }

  renameSync(join(work, `${name}.sbs`), join(HERE, `${name}.sbs`));
  for (const file of readdirSync(join(work, 'out'))) {
    renameSync(join(work, 'out', file), join(OUT, `${name}-${file}`));
  }
  console.log(`baked ${name} -> assets/materials/${name}-{normal,roughness}.png`);
}

const TAU = Math.PI * 2;

/**
 * Match-shirt fabric: a warp-knit athletic mesh. Rows of eyelets on a
 * half-drop, each one a dip in the yarn, over a faint vertical wale. That
 * micro-relief is what makes a lit shirt read as cloth rather than as paint.
 */
await bake('jersey', 256, async ({ fn, height, node, route }) => {
  const CELLS = 32;
  const p = fn.mul(fn.pos(), fn.vec2(CELLS, CELLS));
  const px = fn.x(p);
  const py = fn.y(p);
  const row = fn.floor(py);
  const shifted = fn.add(px, fn.mul(0.5, fn.mod(row, 2)));
  const cx = fn.sub(fn.fract(shifted), 0.5);
  const cy = fn.sub(fn.fract(py), 0.5);
  const d = fn.sqrt(fn.add(fn.mul(cx, cx), fn.mul(fn.mul(cy, cy), 1.6)));
  const eyelet = fn.smoothstep(0.12, 0.40, d);
  const wale = fn.mul(0.10, fn.sin(fn.mul(px, TAU)));
  await fn.output(fn.clamp01(fn.add(fn.mul(0.82, eyelet), fn.add(0.09, wale))));

  await route(height, 'height');
  await route(await node('normal', height, { intensity: 1.2, opengl: true }, [-300, 120]), 'normal');
  // The yarn is matt; the open eyelets catch a little more of the light.
  await route(await node('levels', height, { out_low: 0.46, out_high: 0.74 }, [-300, 240]), 'roughness');
});

/** Sock and shorts-waistband rib: a plain 2x2 knit, ribs running up the leg. */
await bake('rib', 256, async ({ fn, height, node, route }) => {
  const RIBS = 24;
  const p = fn.pos();
  const u = fn.mul(fn.x(p), RIBS);
  const v = fn.mul(fn.y(p), RIBS * 2.5);
  const rib = fn.pow(fn.abs(fn.sin(fn.mul(u, Math.PI))), 0.55);
  // Stitches: a chevron down each rib, offset rib to rib.
  const stitch = fn.abs(fn.sub(fn.fract(fn.add(v, fn.mul(0.5, fn.floor(u)))), 0.5));
  await fn.output(fn.clamp01(fn.add(fn.mul(0.80, rib), fn.mul(0.36, stitch))));

  await route(height, 'height');
  await route(await node('normal', height, { intensity: 1.6, opengl: true }, [-300, 120]), 'normal');
  await route(await node('levels', height, { out_low: 0.58, out_high: 0.86 }, [-300, 240]), 'roughness');
});

/**
 * Turf blades: per-pixel noise drawn out along one axis into fibres, then
 * sharpened. Tiled finely over the pitch it breaks up the mown stripes with
 * the grain of real grass.
 */
await bake('turf', 256, async ({ fn, height, node, route }) => {
  // A per-texel hash (the Random node is seeded once per cook, not per pixel).
  const texel = fn.floor(fn.mul(fn.pos(), fn.vec2(256, 256)));
  const phase = fn.add(fn.mul(fn.x(texel), 12.9898), fn.mul(fn.y(texel), 78.233));
  await fn.output(fn.fract(fn.mul(fn.sin(phase), 43758.5453)));
  const fibres = await node('directional_blur', height, { intensity: 9, angle: 0.25 }, [-450, 0]);
  const soft = await node('blur', fibres, { intensity: 0.6 }, [-300, 0]);
  const blades = await node('levels', soft, { in_low: 0.36, in_high: 0.64 }, [-150, 0]);
  await route(blades, 'height');
  await route(await node('normal', blades, { intensity: 1.4, opengl: true }, [0, 120]), 'normal');
  await route(await node('levels', blades, { out_low: 0.70, out_high: 0.98 }, [0, 240]), 'roughness');
});

rmSync(join(HERE, '.work'), { recursive: true, force: true });
if (!existsSync(join(OUT, 'jersey-normal.png'))) process.exit(1);
