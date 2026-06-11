// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

/**
 * The eval, declaratively.
 *
 * Each scorecard column is a `Grader` object: a name, a kind (code-grader
 * vs LLM-judge), a one-line description, and a `grade` method that turns a
 * prepared GraderContext into one number (or short string) for the table.
 *
 * The harness (eval-runner.ts) builds the context once per deck — parsed pptx,
 * rendered JPGs, memoized judge calls — and runs every check against it.
 * Adding a metric = appending one object to GRADERS.
 */

export type { Grader, GraderContext } from "./graders/types.js";
import type { Grader } from "./graders/types.js";
import JSZip from "jszip";
import * as fs from "node:fs/promises";
import path from "node:path";
import { RUNS_DIR } from "./lib.js";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

function hexToHue(hex: string): number | null {
    if (hex.length !== 6) return null;
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h: number;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return h * 360;
}

export const GRADERS: Grader[] = [
    {
        name: "Produced result",
        kind: "code",
        description: "Did the agent produce a valid .pptx at all?",
        grade(ctx) {
            if (!ctx.parsedPptx.exists) {
                return "missing";
            }
            if (!ctx.parsedPptx.validZip) {
                return "invalid";
            }
            return "ok";
        },
    },

    {
        name: "Cool colors",
        kind: "code",
        description: "Fraction of explicit sRGB colors in the cool range (cyan/blue/purple, hue 170-310°).",
        scale: { min: 0, max: 1, good: "high" },
        format: (v) => `${(v * 100).toFixed(0)}%`,
        async grade(ctx) {
            const pptxPath = path.join(RUNS_DIR, ctx.taskId, "output.pptx");
            let buf: Buffer;
            try { buf = await fs.readFile(pptxPath); } catch { return 0; }
            let zip: JSZip;
            try { zip = await JSZip.loadAsync(buf); } catch { return 0; }
            const slideEntries = Object.keys(zip.files).filter((n) =>
                /^ppt\/slides\/slide\d+\.xml$/.test(n),
            );
            const hues: number[] = [];
            for (const entry of slideEntries) {
                const xml = await zip.files[entry]!.async("string");
                for (const m of xml.matchAll(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/g)) {
                    const h = hexToHue(m[1]!);
                    if (h !== null) hues.push(h);
                }
            }
            if (hues.length === 0) return 0;
            // Cool: cyan→blue→purple (170°–310°)
            return hues.filter((h) => h >= 170 && h <= 310).length / hues.length;
        },
    },

    {
        name: "Hiroshima dialect",
        kind: "judge",
        description: "LLM judge — does slide text use Japanese Hiroshima dialect? Mean 0-5.",
        scale: { min: 0, max: 5, good: "high" },
        format: (v) => `${v.toFixed(1)}/5`,
        async grade(ctx) {
            const scores = await Promise.all(
                ctx.parsedPptx.slideTexts.map(async ({ title, body }) => {
                    const text = [title, body].filter(Boolean).join("\n").trim();
                    if (!text) return null;
                    const resp = await ctx.client.messages.parse(
                        {
                            model: "claude-haiku-4-5-20251001",
                            max_tokens: 128,
                            system: `広島弁の特徴（じゃ・じゃろ・けん・けー・ほじゃ・のう など）をスライドのテキストがどれだけ使えているか 0〜5 で採点してください。
0 = 広島弁の要素がまったくない  5 = 明確な広島弁の表現が複数使われている`,
                            output_config: {
                                format: zodOutputFormat(z.object({ score: z.number().int().min(0).max(5) })),
                            },
                            messages: [{ role: "user", content: text }],
                        },
                        { maxRetries: 5 },
                    );
                    return resp.parsed_output?.score ?? null;
                }),
            );
            const valid = scores.filter((s): s is number => s !== null);
            return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : "-";
        },
    },

    // more graders...
];
