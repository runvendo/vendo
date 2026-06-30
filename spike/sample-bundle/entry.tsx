import React from "react";
import { createRoot } from "react-dom/client";
import { Card } from "./Card";
import { Boom } from "./Boom";
import { Row } from "./Row";
(globalThis as any).__React = React;
(globalThis as any).__createRoot = createRoot;
(globalThis as any).__FLOWLET_HOST__ = { Card, Boom, __row: Row };
