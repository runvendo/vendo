import "@testing-library/jest-dom";

// jsdom doesn't implement HTMLCanvasElement.getContext; stub it so chart
// components that use a canvas for text measurement don't throw.
HTMLCanvasElement.prototype.getContext = function () {
  return {
    font: "",
    measureText: () => ({ width: 0 }),
    fillText: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
  } as unknown as CanvasRenderingContext2D;
};

// jsdom doesn't implement ResizeObserver; stub it so Recharts'
// ResponsiveContainer doesn't throw.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
