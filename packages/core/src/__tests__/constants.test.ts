import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../constants";

describe("expandHome", () => {
	it("expands ~/path to absolute path", () => {
		expect(expandHome("~/foo")).toBe(join(homedir(), "foo"));
	});

	it("expands bare ~ to homedir", () => {
		expect(expandHome("~")).toBe(homedir());
	});

	it("leaves ~foo unchanged (no separator — not a home path)", () => {
		expect(expandHome("~foo")).toBe("~foo");
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandHome("/absolute/path")).toBe("/absolute/path");
	});

	it("leaves relative paths unchanged", () => {
		expect(expandHome("relative/path")).toBe("relative/path");
	});
});
