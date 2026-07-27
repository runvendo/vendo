import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {VendoKnowledgeCitation} from '@vendoai/core';
import {C, FILM_Z, snap} from '../template/theme';
import {Cursor} from '../template/Cursor';
import {OverlayPanel} from '../template/OverlayPanel';
import {VendoStage} from '../template/VendoStage';
import {
  CARD,
  FADE0,
  FADE1,
  LIFT_AT,
  PANEL_SLIDE,
  WIDGET,
  chatCam,
  panelRise,
} from '../template/chatShared';
import {
  Transcript,
  answerTurn,
  typedText,
  userTurn,
  viewTurn,
  weeklyUsagePayload,
} from './agent-surface';

// Frames 75-252 (177 local). ONE continuous chat panel, two proofs, rendered
// by the REAL agent surface: the panel is the product's own VendoOverlay, the
// transcript is the product's own MessageList, and the keep affordance is the
// product's own "Pin to dashboard" control. The film supplies the state, the
// geometry and the motion; packages/ui supplies every pixel.
//
// The orb-whip overlay lands on the panel's top-left while the panel slides up;
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
const B_CLICK = 154;

/** The centre of the real `.fl-cite-btn` in the Sources row, and the centre of
 *  the real `.fl-barpin` "Pin to dashboard" button on the app card's bar. Both
 *  are MEASURED off `getBoundingClientRect()` in a real render and divided back
 *  through the scene camera — never guessed. See the evidence README. */
const CHIP = {x: CARD.x + 88, y: CARD.y + 236};
const PIN = {x: CARD.x + 731, y: CARD.y + 256};

/**
 * The transcript pane's padding, from `.fl-msglist { padding: 18px 16px 10px }`
 * in packages/ui/src/chrome/chrome-css.ts. The film positions BY the message
 * rather than by the pane, so the pinned rects (CARD-relative message top,
 * WIDGET for the flight pickup) stay exactly where the prototype put them.
 */
const PANE_PAD = {top: 18, left: 16};

/** An assistant turn's own leading offset inside the pane (`.fl-turn-assistant`
 *  vs `.fl-msglist` top, measured: 11px). Subtracted so the app card lands on
 *  the pinned WIDGET rect the flight overlay lifts from. */
const TURN_TOP = 11;

export interface SceneChatProps {
  /** The question the user types first. */
  askA: string;
  /** The grounded answer, and the sources that back it. */
  answer: string;
  citations: VendoKnowledgeCitation[];
  /** The build request that produces the in-thread view. */
  askB: string;
}

export const SceneChat: React.FC<SceneChatProps> = ({
  askA,
  answer,
  citations,
  askB,
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
  // payload's own `streaming` flag, and reveals its own pin control when the
  // build settles (which is what the cursor then clicks).
  const frameSnap = snap(frame, fps, B_FRAME);
  const reveal = {
    stats: frame >= B_STATS,
    chart: frame >= B_CHART,
    schedule: frame >= B_PILL,
  };

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
    <AbsoluteFill>
      <AbsoluteFill style={{backgroundColor: C.bg, opacity: out}} />
      <VendoStage>
        <OverlayPanel
          rect={CARD}
          rise={rise}
          cam={cam * outScale}
          opacity={out}
          motion={panelMotion}
        >
          {/* Everything below is film layout INSIDE the real panel: where the
              transcript sits and how it moves on the beat. No product surface
              is drawn here — every visible element comes out of packages/ui. */}
          <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: `translateY(${scroll}px)`,
              }}
            >
              {/* ---- Proof A ---- */}
              {/* The answer's pinned spring entrance (rise 26px + scale
                  overshoot). The turn is a child of the real message list, so
                  the film cannot wrap it — it addresses it instead, through a
                  rule scoped to this film wrapper and re-emitted every frame,
                  which keeps the motion frame-driven. */}
              {reply.o > 0 ? (
                <style>{`.vs-proof-a .fl-msglist > *:last-child {
                  opacity: ${reply.o};
                  transform: translateY(${(1 - reply.s) * 26}px)
                    scale(${0.85 + 0.15 * reply.s});
                  transform-origin: left top;
                }`}</style>
              ) : null}
              <div
                className="vs-proof-a"
                style={{
                  position: 'absolute',
                  top: 78 - PANE_PAD.top,
                  left: 0,
                  right: 0,
                  filter: aBlur > 0.05 ? `blur(${aBlur}px)` : undefined,
                }}
              >
                <Transcript
                  messages={[
                    ...(frame >= A_TYPE - 2
                      ? [userTurn('a-user', askATyped)]
                      : []),
                    ...(reply.o > 0
                      ? [
                          answerTurn(
                            'a-answer',
                            answer,
                            frame >= A_CHIP ? citations : undefined,
                          ),
                        ]
                      : []),
                  ]}
                />
              </div>

              {/* ---- Proof B user turn (rides up with the scroll) ---- */}
              {frame >= S_START ? (
                <div
                  style={{
                    position: 'absolute',
                    top: 78 - PANE_PAD.top + SCROLL,
                    left: 0,
                    right: 0,
                  }}
                >
                  <Transcript messages={[userTurn('b-user', askBTyped)]} />
                </div>
              ) : null}
            </div>

            {/* The generated view: the REAL in-thread app card, streaming its
                payload revisions and carrying its own "Pin to dashboard"
                control. Held at the pinned rect the flight overlay picks it
                up from. */}
            {frame >= B_FRAME && frame < LIFT_AT ? (
              <div
                style={{
                  position: 'absolute',
                  left: WIDGET.x - CARD.x - PANE_PAD.left,
                  top: WIDGET.y - CARD.y - PANE_PAD.top - TURN_TOP,
                  width: WIDGET.w + PANE_PAD.left * 2,
                  opacity: frameSnap.o,
                  transform: `translateY(${(1 - frameSnap.s) * 34}px) scale(${
                    0.88 + 0.12 * frameSnap.s
                  })`,
                  transformOrigin: 'center top',
                }}
              >
                <Transcript
                  messages={[
                    viewTurn(
                      'b-view',
                      'weekly-usage',
                      weeklyUsagePayload(reveal, !reveal.schedule),
                    ),
                  ]}
                />
              </div>
            ) : null}
          </div>
        </OverlayPanel>
      </VendoStage>

      {/* The cursor rides the same camera as the scene, on its own layer — the
          real panel portals to document.body above the film, so the film's
          layers carry explicit z-indexes over it (FILM_Z). */}
      <AbsoluteFill
        style={{
          transform: `scale(${cam * outScale})`,
          opacity: out,
          zIndex: FILM_Z.cursor,
        }}
      >
        <Cursor
          path={[
            {frame: 0, x: 1560, y: 920},
            {frame: 36, x: 1180, y: 740, bulge: -70},
            {frame: A_HOVER, x: CHIP.x, y: CHIP.y, bulge: 60},
            {frame: 100, x: 1350, y: 700, bulge: 40},
            {frame: 130, x: 1050, y: 600, bulge: -70},
            {
              frame: B_CLICK,
              x: PIN.x,
              y: PIN.y,
              click: true,
              bulge: 60,
            },
            {frame: 174, x: PIN.x + 12, y: PIN.y + 14},
          ]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
