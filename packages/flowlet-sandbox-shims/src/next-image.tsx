/**
 * `next/image` shim → a plain img with the same prop surface. src is still
 * subject to the sandbox CSP (data: only for host-injected assets); remote
 * srcs simply fail to load, same as any other blocked request.
 */
import { createElement, type ImgHTMLAttributes } from "react";

export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string | { src: string };
  // Accepted for API-compat; approximated or ignored.
  fill?: boolean;
  priority?: boolean;
  quality?: number;
}

export default function Image({ src, fill, priority: _p, quality: _q, style, ...rest }: ImageProps) {
  const source = typeof src === "string" ? src : src.src;
  const fillStyle = fill
    ? { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const }
    : undefined;
  return createElement("img", { ...rest, src: source, style: { ...fillStyle, ...style } });
}
