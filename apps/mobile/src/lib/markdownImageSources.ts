import {
  markdownImageUrlResolver,
  parseMarkdownDocument,
  type MarkdownNode,
} from "./markdownDocument";

export function markdownImageSources(markdown: string): string[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const root = parseMarkdownDocument(markdown);
  const imageUrl = markdownImageUrlResolver(root);
  const sources = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "image" || node.type === "imageReference") {
      const href = imageUrl(node);
      if (href !== undefined) sources.add(href);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return [...sources];
}
