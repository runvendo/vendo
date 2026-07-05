import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AutomationCard, automationCardModel } from "./AutomationCard";
import { BrandIcon } from "./BrandIcon";
import { loadFluidMotion, type FluidMotion } from "./fluid-motion";

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];
export const AUTOMATION_CREATED_HOLD_MS = 2600;
const AUTOMATION_CREATED_REDUCED_HOLD_MS = 1600;
const AUTOMATION_CREATED_TOAST_HEIGHT = 58;

export interface AutomationCreatedRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface AutomationCreatedNotice {
  id: string;
  toolName: string;
  input: unknown;
  sourceRect?: AutomationCreatedRect;
}

interface AutomationCreatedMorphProps {
  notice: AutomationCreatedNotice;
  onDone: (id: string) => void;
}

function stopAll(animations: Array<{ stop?: () => void }>) {
  for (const animation of animations) animation.stop?.();
}

function settleAll(animations: Array<unknown>): Promise<unknown[]> {
  return Promise.all(animations.map((animation) => Promise.resolve(animation).catch(() => undefined)));
}

export function AutomationCreatedMorph({ notice, onDone }: AutomationCreatedMorphProps) {
  const model = useMemo(() => automationCardModel(notice.toolName, notice.input), [notice.toolName, notice.input]);
  const [face, setFace] = useState<"morph" | "toast">(notice.sourceRect ? "morph" : "toast");
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const proposalRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const animations = useRef<Array<{ stop?: () => void }>>([]);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    return () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      stopAll(animations.current);
    };
  }, []);

  useLayoutEffect(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
    stopAll(animations.current);
    animations.current = [];

    const panel = panelRef.current;
    const layer = layerRef.current;
    if (!model || !panel || !layer) {
      onDoneRef.current(notice.id);
      return;
    }

    let cancelled = false;
    const source = notice.sourceRect;

    const destination = () => {
      const availableWidth = Math.max(160, layer.clientWidth - 32);
      const width = Math.min(292, availableWidth);
      return {
        top: Math.max(18, (source?.top ?? 36) - 18),
        left: Math.max(16, layer.clientWidth - width - 16),
        width,
        height: AUTOMATION_CREATED_TOAST_HEIGHT,
      };
    };

    const place = (rect: AutomationCreatedRect) => {
      panel.style.top = `${rect.top}px`;
      panel.style.left = `${rect.left}px`;
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
    };

    const clearMotionStyles = () => {
      panel.style.overflow = "";
      const proposal = proposalRef.current;
      const toast = toastRef.current;
      if (proposal) {
        proposal.style.opacity = "";
        proposal.style.filter = "";
      }
      if (toast) {
        toast.style.opacity = "";
        toast.style.filter = "";
      }
    };

    const finish = (toolkit: FluidMotion | null, delay: number) => {
      timers.current.push(
        window.setTimeout(() => {
          if (cancelled) return;
          const currentPanel = panelRef.current;
          const canAnimate = toolkit && toolkit.prefersReducedMotion() !== true && currentPanel;
          if (!canAnimate) {
            onDoneRef.current(notice.id);
            return;
          }
          const exit = toolkit.animate(
            currentPanel,
            { opacity: [1, 0], transform: ["translateY(0px) scale(1)", "translateY(-8px) scale(.985)"] },
            { duration: 0.24, ease: "easeOut" },
          ) as unknown as { stop?: () => void };
          animations.current = [exit];
          void settleAll([exit]).then(() => {
            if (!cancelled) onDoneRef.current(notice.id);
          });
        }, delay),
      );
    };

    if (source) place(source);
    else place(destination());

    void loadFluidMotion().then((toolkit) => {
      if (cancelled) return;
      const reduce = toolkit?.prefersReducedMotion() === true;
      const dest = destination();

      if (!source || !toolkit || reduce) {
        setFace("toast");
        place(dest);
        finish(toolkit, reduce ? AUTOMATION_CREATED_REDUCED_HOLD_MS : AUTOMATION_CREATED_HOLD_MS);
        return;
      }

      panel.style.overflow = "hidden";
      const proposal = proposalRef.current;
      const toast = toastRef.current;
      if (toast) toast.style.opacity = "0";

      const morph = [
        toolkit.animate(
          panel,
          {
            top: [`${source.top}px`, `${dest.top}px`],
            left: [`${source.left}px`, `${dest.left}px`],
            width: [`${source.width}px`, `${dest.width}px`],
            height: [`${source.height}px`, `${dest.height}px`],
            borderRadius: ["12px", "14px"],
          },
          { duration: 0.58, ease: EASE },
        ),
        proposal
          ? toolkit.animate(
              proposal,
              { opacity: [1, 0], filter: ["blur(0px)", "blur(4px)"] },
              { duration: 0.24, ease: "easeOut" },
            )
          : undefined,
        toast
          ? toolkit.animate(
              toast,
              { opacity: [0, 1], filter: ["blur(6px)", "blur(0px)"] },
              { duration: 0.36, delay: 0.13, ease: EASE },
            )
          : undefined,
      ].filter(Boolean);

      animations.current = morph as Array<{ stop?: () => void }>;
      void settleAll(morph).then(() => {
        if (cancelled) return;
        clearMotionStyles();
        setFace("toast");
        finish(toolkit, AUTOMATION_CREATED_HOLD_MS);
      });
    });

    return () => {
      cancelled = true;
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
      stopAll(animations.current);
      animations.current = [];
      clearMotionStyles();
    };
  }, [model, notice.id, notice.sourceRect]);

  if (!model) return null;
  const apps = model.access.slice(0, 3);
  const appNames = apps.map((app) => app.name).join(", ");

  return (
    <div className="fl-auto-created-layer" ref={layerRef}>
      <div className={`fl-auto-created-panel fl-auto-created-panel--${face}`} ref={panelRef}>
        {face === "morph" ? (
          <div className="fl-auto-created-proposal" ref={proposalRef} aria-hidden="true">
            <AutomationCard
              toolName={notice.toolName}
              input={notice.input}
              onApprove={() => undefined}
              onDecline={() => undefined}
            />
          </div>
        ) : null}

        <div
          className="fl-auto-created-toast"
          ref={toastRef}
          role="status"
          aria-live="polite"
          aria-label={`Automation running: ${model.name}${appNames ? ` using ${appNames}` : ""}`}
        >
          <span className="fl-auto-created-live" aria-hidden="true" />
          <div className="fl-auto-created-copy">
            <div className="fl-auto-created-title">Automation running</div>
            <div className="fl-auto-created-sub">{model.name}</div>
          </div>
          {apps.length > 0 ? (
            <div className="fl-auto-created-logos" aria-label={`Uses ${appNames}`}>
              {apps.map((app) => (
                <span className="fl-auto-created-logo" key={app.key} title={app.name}>
                  <BrandIcon id={app.brandId} size={18} />
                  {app.actions.length > 1 ? (
                    <span className="fl-auto-created-count" aria-hidden="true">{app.actions.length}</span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
