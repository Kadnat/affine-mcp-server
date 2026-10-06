import assert from "node:assert/strict";
import { layoutNodes } from "../dist/edgeless/layout.js";

const n = (key, width = 200, height = 100) => ({ key, width, height });

// flow right: a -> b -> d, a -> c -> d : three columns, b/c stacked, a/d centered
const flow = layoutNodes([n("a"), n("b"), n("c"), n("d")], [
  { from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" },
], { mode: "flow", gapX: 80, gapY: 60 });
assert.deepEqual(flow.get("a"), { x: 0, y: 80 });
assert.deepEqual(flow.get("b"), { x: 280, y: 0 });
assert.deepEqual(flow.get("c"), { x: 280, y: 160 });
assert.deepEqual(flow.get("d"), { x: 560, y: 80 });

// flow down swaps axes
const down = layoutNodes([n("a"), n("b")], [{ from: "a", to: "b" }], { mode: "flow", direction: "down", gapY: 60 });
assert.deepEqual(down.get("b"), { x: 0, y: 160 });

// cycles terminate
const cyc = layoutNodes([n("a"), n("b")], [{ from: "a", to: "b" }, { from: "b", to: "a" }], { mode: "flow" });
assert.equal(cyc.size, 2);

// grid: 4 nodes -> 2 columns, smaller node centered in its cell, origin applied
const grid = layoutNodes([n("a"), n("b", 100, 50), n("c"), n("d")], [], { mode: "grid", gapX: 80, gapY: 60, originX: 10, originY: 20 });
assert.deepEqual(grid.get("b"), { x: 10 + 280 + 50, y: 20 + 25 });
assert.deepEqual(grid.get("c"), { x: 10, y: 20 + 160 });

// row / column
assert.deepEqual(layoutNodes([n("a"), n("b")], [], { mode: "row" }).get("b"), { x: 280, y: 0 });
assert.deepEqual(layoutNodes([n("a"), n("b")], [], { mode: "column" }).get("b"), { x: 0, y: 160 });

console.log("layoutNodes tests passed");
