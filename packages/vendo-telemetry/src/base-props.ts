import { platform } from "node:os";

export interface BaseProps {
  vendoVersion: string;
  osPlatform: string;
  nodeVersion: string;
}

export function baseProps(version: string): BaseProps {
  return {
    vendoVersion: version,
    osPlatform: platform(),
    nodeVersion: process.version,
  };
}
