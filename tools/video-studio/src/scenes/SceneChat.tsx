import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {VendoKnowledgeCitation} from '@vendoai/core';
import {C, cardShadow, cardStyle, snap, snapStyle} from '../template/theme';
import {Cursor} from '../template/Cursor';
import {VendoStage} from '../template/VendoStage';
import {
  CARD,
  DOT_HANDOFF,
  FADE0,
  FADE1,
  LIFT_AT,
  PANEL_SLIDE,
  WIDGET,
  chatCam,
  panelRise,
} from '../template/chatShared';
import {
  Turn,
  answerTurn,
  typedText,
  userTurn,
  viewTurn,
  weeklyUsagePayload,
} from './agent-surface';

// Frames 75-252 (177 local). ONE continuous chat panel, two proofs, rendered
// by the REAL agent surface: every message, the Sources chip row and the
// in-thread app card come from packages/ui. The film supplies the state and
// the motion; packages/ui supplies the pixels.
//
// The orb-whip overlay lands on the header dot while the panel slides up;
// proof A (the SSO answer) plays, the camera pushes in as the answer lands,
// then the content scrolls up (old messages blur out the top) and proof B (the
// weekly report view) streams into the same panel as successive payload
// revisions. At the end the view hands off to the flight overlay and the whole
// scene recedes.

// Phase A beats (chat-local)
const A_TYPE = 6;
const A_REPLY = 46;
const A_CHIP = 54;
const A_HOVER = 62;
// Scroll transition: proof A exits top, proof B types in.
const S_START = 70;
const S_END = 82;
const SCROLL = 640;
// Phase B beats
const B_TYPE = 76;
const B_FRAME = 118;
const B_STATS = 118;
const B_CHART = 128;
const B_PILL = 150;
const B_KEEP = 148;
const B_CLICK = 154;

/** Where the cursor visits the real Sources chip. Calibrated against a
 *  rendered frame, never guessed — see docs/verification/video-harness. */
const CHIP = {x: CARD.x + 90, y: CARD.y + 253};

const KEEP = {
  x: WIDGET.x + WIDGET.w - 150,
  y: WIDGET.y + WIDGET.h - 76,
  w: 118,
  h: 54,
};

export interface SceneChatProps {
  /** The question the user types first. */
  askA: string;
  /** The grounded answer, and the sources that back it. */
  answer: string;
  citations: VendoKnowledgeCitation[];
  /** The build request that produces the in-thread view. */
  askB: string;
  /** Label on the button that keeps the generated view. */
  keepLabel?: string;
}

/** The panel header the orb-whip match-cuts into. Its violet status dot is the
 *  landing target of a pinned transition, so this geometry is film grammar —
 *  see PARKED.md on why the real overlay panel shell cannot sit here. */
const PanelHeader: React.FC<{dotVisible: boolean}> = ({dotVisible}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '22px 32px',
      borderBottom: '1px solid rgba(14,11,26,0.07)',
      backgroundColor: C.white,
      borderRadius: '12px 12px 0 0',
      position: 'relative',
      zIndex: 5,
    }}
  >
    <div
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        backgroundColor: C.violet,
        opacity: dotVisible ? 1 : 0,
      }}
    />
    <div style={{fontSize: 21, fontWeight: 600, color: C.body}}>Assistant</div>
  </div>
);

export const SceneChat: React.FC<SceneChatProps> = ({
  askA,
  answer,
  citations,
  askB,
  keepLabel = 'Keep',
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const rise = panelRise(frame, fps);
  const panelMotion = Math.min(rise / (PANEL_SLIDE * 0.5), 1);

  const reply = snap(frame, fps, A_REPLY);

  // Scroll transition
  const scroll = interpolate(frame, [S_START, S_END], [0, -SCROLL], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const aBlur = interpolate(frame, [S_START + 2, S_END], [0, 3], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Phase B: the view streams in as payload revisions, exactly the way a live
  // build arrives — the real app card narrates building → ready off the
  // payload's own `streaming` flag.
  const frameSnap = snap(frame, fps, B_FRAME);
  const reveal = {
    stats: frame >= B_STATS,
    chart: frame >= B_CHART,
    schedule: frame >= B_PILL,
  };
  const keepSnap = snap(frame, fps, B_KEEP);
  const keepOut = interpolate(frame, [B_CLICK + 4, B_CLICK + 10], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Camera + scene fade-back under the incoming dashboard.
  const cam = chatCam(frame);
  const out = interpolate(frame, [FADE0, FADE1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outScale = interpolate(frame, [FADE0, FADE1], [1, 0.96], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const askATyped = typedText(askA, frame - A_TYPE);
  const askBTyped = typedText(askB, frame - B_TYPE);

  return (
    <AbsoluteFill style={{opacity: out}}>
      <AbsoluteFill style={{backgroundColor: C.bg}} />
      <AbsoluteFill style={{transform: `scale(${cam * outScale})`}}>
        <VendoStage>
          {/* The chat panel — slides up under the arriving orb-dot */}
          <div
            style={{
              ...cardStyle,
              position: 'absolute',
              left: CARD.x,
              top: CARD.y,
              width: CARD.w,
              height: CARD.h,
              transform: `translateY(${rise}px)`,
              boxShadow: cardShadow(panelMotion),
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: `translateY(${scroll}px)`,
              }}
            >
              {/* ---- Proof A ---- */}
              <div
                style={{
                  position: 'absolute',
                  top: 78,
                  left: 0,
                  right: 0,
                  filter: aBlur > 0.05 ? `blur(${aBlur}px)` : undefined,
                }}
              >
                <div className="fl-thread">
                  <div className="fl-msglist" style={{overflow: 'visible'}}>
                    {frame >= A_TYPE - 2 ? (
                      <Turn message={userTurn('a-user', askATyped)} />
                    ) : null}
                    {reply.o > 0 ? (
                      <div
                        style={{
                          ...snapStyle(reply.s, reply.o, 26),
                          transformOrigin: 'left top',
                        }}
                      >
                        <Turn
                          message={answerTurn(
                            'a-answer',
                            answer,
                            frame >= A_CHIP ? citations : undefined,
                          )}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* ---- Proof B user turn (rides up with the scroll) ---- */}
              {frame >= S_START ? (
                <div
                  style={{
                    position: 'absolute',
                    top: 78 + SCROLL,
                    left: 0,
                    right: 0,
                  }}
                >
                  <div className="fl-thread">
                    <div className="fl-msglist" style={{overflow: 'visible'}}>
                      <Turn message={userTurn('b-user', askBTyped)} />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <PanelHeader dotVisible={frame >= DOT_HANDOFF} />
          </div>

          {/* The generated view: the REAL in-thread app card, streaming its
              payload revisions. Held at the pinned rect the flight overlay
              picks it up from. */}
          {frame >= B_FRAME && frame < LIFT_AT ? (
            <div
              style={{
                position: 'absolute',
                left: WIDGET.x,
                top: WIDGET.y,
                width: WIDGET.w,
                opacity: frameSnap.o,
                transform: `translateY(${(1 - frameSnap.s) * 34}px) scale(${
                  0.88 + 0.12 * frameSnap.s
                })`,
                transformOrigin: 'center top',
              }}
            >
              <Turn
                message={viewTurn(
                  'b-view',
                  'weekly-usage',
                  weeklyUsagePayload(reveal, !reveal.schedule),
                )}
              />
            </div>
          ) : null}

          {/* Keep button — ink, never violet */}
          {keepOut > 0 && frame < LIFT_AT ? (
            <div
              style={{
                position: 'absolute',
                left: KEEP.x,
                top: KEEP.y,
                width: KEEP.w,
                height: KEEP.h,
                borderRadius: 10,
                backgroundColor: C.ink,
                color: C.white,
                fontSize: 22,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(14,11,26,0.22)',
                ...snapStyle(keepSnap.s, keepSnap.o * keepOut, 16),
              }}
            >
              {keepLabel}
            </div>
          ) : null}
        </VendoStage>

        <Cursor
          path={[
            {frame: 0, x: 1560, y: 920},
            {frame: 36, x: 1180, y: 740, bulge: -70},
            {frame: A_HOVER, x: CHIP.x, y: CHIP.y, bulge: 60},
            {frame: 100, x: 1350, y: 700, bulge: 40},
            {frame: 130, x: 1050, y: 600, bulge: -70},
            {
              frame: B_CLICK,
              x: KEEP.x + KEEP.w / 2 + 8,
              y: KEEP.y + KEEP.h / 2 + 4,
              click: true,
              bulge: 60,
            },
            {
              frame: 174,
              x: KEEP.x + KEEP.w / 2 + 16,
              y: KEEP.y + KEEP.h / 2 + 12,
            },
          ]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
