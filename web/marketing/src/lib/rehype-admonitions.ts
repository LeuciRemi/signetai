import { visit } from "unist-util-visit";

/**
 * Classifies markdown blockquotes into styled admonitions based on their
 * leading label (e.g. `> **Note:** ...` -> `admonition--note`,
 * `> **Warning:** ...` -> `admonition--warning`). The label stays in the
 * content and is styled as a small tag by docs.css.
 */
const KINDS: Record<string, string> = {
	note: "note",
	info: "note",
	"path note": "note",
	tip: "note",
	warning: "warning",
	caution: "warning",
	important: "warning",
};

interface HNode {
	type: string;
	tagName?: string;
	children?: HNode[];
	properties?: Record<string, unknown>;
	value?: string;
}

function textOf(node: HNode): string {
	let out = "";
	for (const child of node.children ?? []) {
		if (child.type === "text") out += child.value ?? "";
		else if (child.type === "element") out += textOf(child);
	}
	return out;
}

export default function rehypeAdmonitions() {
	return (tree: HNode) => {
		visit(tree, "element", (node: HNode) => {
			if (node.tagName !== "blockquote") return;

			const firstP = (node.children ?? []).find((c): c is HNode => c.type === "element" && c.tagName === "p");
			if (!firstP) return;

			const label = textOf(firstP).split(":")[0].trim().toLowerCase();
			const kind = KINDS[label];
			if (!kind) return;

			node.properties = node.properties ?? {};
			const existing = node.properties.className;
			const classes = Array.isArray(existing) ? (existing as string[]) : [];
			node.properties.className = [...classes, "admonition", `admonition--${kind}`];
		});
	};
}
