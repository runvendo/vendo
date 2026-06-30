"use client";

/**
 * The closing beat made literal: every view Flowlet generated persists as a
 * tappable card. Click one to reopen the full view. Sits bottom-left so it never
 * collides with the dock (bottom-right).
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { renderNode } from "./render-node";
import type { SavedView } from "./FlowletSaver";

export function SavedViews({ views }: { views: SavedView[] }) {
  const [open, setOpen] = useState<SavedView | null>(null);
  if (views.length === 0) return null;

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 24,
          bottom: 24,
          zIndex: 49,
          maxWidth: "min(520px, calc(100vw - 500px))",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <span
          style={{
            font: "600 10px/1 var(--font-inter, system-ui)",
            letterSpacing: ".09em",
            textTransform: "uppercase",
            color: "#908C85",
          }}
        >
          Your views · saved
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {views.map((v, i) => (
            <motion.button
              key={v.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, duration: 0.3 }}
              onClick={() => setOpen(v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #ECEBE8",
                background: "#fff",
                boxShadow: "0 6px 18px rgba(27,30,37,.08)",
                cursor: "pointer",
                font: "500 13px/1 var(--font-inter, system-ui)",
                color: "#1b1d22",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 7, background: "#1E7F53" }} />
              {v.label}
            </motion.button>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              background: "rgba(20,22,26,.42)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              style={{ width: "min(460px, 92vw)", maxHeight: "86vh", overflow: "auto" }}
            >
              {renderNode(open.node)}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
