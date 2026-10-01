// Motion-graphic layer components. Rendered on a TRANSPARENT background, one
// clip per timeline MG item, then composited by ffmpeg. In production this
// file is replaced by ChatCut's own web renderer bundle (same code the editor
// runs), so the export matches the editor preview frame-for-frame.
import React from 'react';
import {
  registerRoot, Composition, AbsoluteFill, useCurrentFrame, useVideoConfig,
  spring, interpolate, Easing,
} from 'remotion';

const font = '"Noto Sans CJK SC","Noto Sans SC",system-ui,sans-serif';

const LowerThird = ({title = 'Name', subtitle = 'Role', accent = '#e2453c'}) => {
  const f = useCurrentFrame();
  const {fps, durationInFrames, height} = useVideoConfig();
  const inP = spring({frame: f, fps, config: {damping: 200}});
  const outP = interpolate(f, [durationInFrames - 12, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic),
  });
  const x = interpolate(inP - outP, [0, 1], [-80, 0]);
  const s = height / 1080;
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', padding: `0 0 ${150 * s}px ${110 * s}px`}}>
      <div style={{transform: `translateX(${x * s}px)`, opacity: inP - outP, display: 'flex', gap: 18 * s}}>
        <div style={{width: 10 * s, background: accent, borderRadius: 4 * s}} />
        <div style={{background: 'rgba(12,14,20,.78)', padding: `${18 * s}px ${30 * s}px`, borderRadius: 10 * s}}>
          <div style={{fontFamily: font, fontWeight: 700, fontSize: 54 * s, color: '#fff', lineHeight: 1.15}}>{title}</div>
          <div style={{fontFamily: font, fontSize: 32 * s, color: 'rgba(255,255,255,.75)', marginTop: 6 * s}}>{subtitle}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const TitleCard = ({text = 'Title', kicker = '', accent = '#e0a10f'}) => {
  const f = useCurrentFrame();
  const {fps, durationInFrames, height} = useVideoConfig();
  const s = height / 1080;
  const p = spring({frame: f, fps, config: {damping: 14, mass: 0.6}});
  const out = interpolate(f, [durationInFrames - 10, durationInFrames], [1, 0], {extrapolateLeft: 'clamp'});
  const bar = interpolate(f, [4, 22], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: out}}>
      {kicker ? <div style={{fontFamily: font, fontSize: 34 * s, letterSpacing: 6 * s, color: accent, marginBottom: 18 * s}}>{kicker}</div> : null}
      <div style={{fontFamily: font, fontWeight: 700, fontSize: 112 * s, color: '#fff', transform: `scale(${0.85 + 0.15 * p})`, textShadow: `0 ${6 * s}px ${30 * s}px rgba(0,0,0,.55)`}}>{text}</div>
      <div style={{height: 8 * s, width: `${bar * 46}%`, background: accent, marginTop: 24 * s, borderRadius: 4 * s}} />
    </AbsoluteFill>
  );
};

// Every MG item arrives as inputProps: {component, props, fps, width, height, durationInFrames}
// calculateMetadata receives the whole inputProps object, i.e. {props: {...}}.
const meta = ({props: input}) => {
  const p = input.props ?? input;
  return {durationInFrames: p.durationInFrames ?? 60, fps: p.fps ?? 30, width: p.width ?? 1920, height: p.height ?? 1080};
};
const Root = () => (
  <>
    <Composition id="LowerThird" component={(p) => <LowerThird {...p.props} />} calculateMetadata={meta}
      durationInFrames={60} fps={30} width={1920} height={1080} defaultProps={{props: {}}} />
    <Composition id="TitleCard" component={(p) => <TitleCard {...p.props} />} calculateMetadata={meta}
      durationInFrames={60} fps={30} width={1920} height={1080} defaultProps={{props: {}}} />
  </>
);
registerRoot(Root);
