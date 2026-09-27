/** Tests the dependency-free framebuffer parser, PNG encoder, and text-model display metrics. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { graphicalQemuTestSupport } from "./graphical-qemu-session.service.js";

function ppm(width: number, height: number, pixels: number[]) {
  return Buffer.concat([
    Buffer.from(`P6\n# QEMU screendump\n${width} ${height}\n255\n`, "ascii"),
    Buffer.from(pixels),
  ]);
}

test("QEMU framebuffer parser accepts P6 comments and exact RGB data", () => {
  const parsed = graphicalQemuTestSupport.readPpm(ppm(2, 1, [255, 0, 0, 0, 255, 0]));
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 1);
  assert.deepEqual([...parsed.pixels], [255, 0, 0, 0, 255, 0]);
});

test("QEMU framebuffer parser preserves a black first pixel", () => {
  const parsed = graphicalQemuTestSupport.readPpm(ppm(2, 1, [0, 0, 0, 255, 255, 255]));
  assert.deepEqual([...parsed.pixels], [0, 0, 0, 255, 255, 255]);
});

test("QEMU framebuffer encoder emits a valid PNG container", () => {
  const png = graphicalQemuTestSupport.encodePng(1, 1, Buffer.from([10, 20, 30]));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.match(png.toString("latin1"), /IHDR/);
  assert.match(png.toString("latin1"), /IDAT/);
  assert.match(png.toString("latin1"), /IEND/);
  assert.equal(createHash("sha256").update(png).digest("hex").length, 64);
});

test("QEMU framebuffer metrics report uniform frames and sampled changes without declaring failure", () => {
  const first = Buffer.alloc(4 * 3, 0);
  const second = Buffer.from(first);
  second.set([255, 255, 255], 0);
  const initial = graphicalQemuTestSupport.analyzeFrame(2, 2, first, null);
  const changed = graphicalQemuTestSupport.analyzeFrame(2, 2, second, first);
  assert.equal(initial.uniformFrame, true);
  assert.equal(initial.changedPixelRatio, null);
  assert.equal(changed.uniformFrame, false);
  assert.equal(changed.changedPixelRatio, 0.25);
  assert.equal(typeof changed.asciiPreview, "string");
});
