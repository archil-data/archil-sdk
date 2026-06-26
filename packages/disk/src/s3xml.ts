import { XMLParser } from "fast-xml-parser";

// Single parser configured for S3's XML responses. Repeated elements
// (`Contents`, `CommonPrefixes`) are forced to arrays so a one-element listing
// parses the same shape as a many-element one. Tag values are kept as strings
// (we coerce numbers ourselves) and XML entities are decoded by the parser.
const parser = new XMLParser({
  isArray: (name) => name === "Contents" || name === "CommonPrefixes",
  parseTagValue: false,
  trimValues: true,
  ignoreAttributes: true,
});

/** Parse an XML document into a plain object. Returns {} for empty/blank input. */
export function parseXml(xml: string): Record<string, unknown> {
  if (!xml.trim()) return {};
  return parser.parse(xml) as Record<string, unknown>;
}
