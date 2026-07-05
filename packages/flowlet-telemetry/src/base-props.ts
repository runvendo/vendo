import { platform } from "node:os";

export interface BaseProps {
  flowletVersion: string;
  osPlatform: string;
  nodeVersion: string;
}

export function baseProps(version: string): BaseProps {
  return {
    flowletVersion: version,
    osPlatform: platform(),
    nodeVersion: process.version,
  };
}
