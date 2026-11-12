import React from 'react';
import { Composition } from 'remotion';
import capture from '../public/capture/capture.json';
import { Trailer, timeline } from './Trailer.jsx';

export const Root = () => (
  <Composition
    id="Trailer"
    component={Trailer}
    durationInFrames={timeline(capture).total}
    fps={capture.fps}
    // Type is laid out for 1080x1920; footage captured smaller is scaled up.
    width={1080}
    height={1920}
    defaultProps={{ capture }}
  />
);
