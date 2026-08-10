"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import type { Tone } from "./model";
import styles from "./workbench.module.css";

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={clsx(styles.chip, styles[tone])}>{children}</span>;
}

export function SectionHead({ label, count }: { label: string; count: ReactNode }) {
  return (
    <div className={styles.secHead}>
      {label}
      <span className={styles.secN}>{count}</span>
      <span className={styles.rule} />
    </div>
  );
}

/** The empty state IS the answer here: "no compaction this turn" is a fact
 *  about the run, not a missing panel. */
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.e1}>{title}</div>
      <div className={styles.e2}>{detail}</div>
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={clsx(styles.chev, open && styles.chevOpen)} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}

/** A row that opens. The body animates on grid rows so it never needs a
 *  measured height, and it stays mounted so the chevron and the content move
 *  together. */
export function Disclosure(
  { open, onToggle, head, className, children }:
  { open: boolean; onToggle: () => void; head: ReactNode; className: string; children: ReactNode },
) {
  return (
    <>
      <button type="button" className={className} aria-expanded={open} onClick={onToggle}>
        {head}
      </button>
      <div className={clsx(styles.exp, open && styles.expOpen)}>
        <div className={styles.expInner}>{children}</div>
      </div>
    </>
  );
}
