// GENERATED from rules/poisoning.json — DO NOT EDIT. Run: npm run build:rules
export default {
  "version": "1.0.0",
  "updated": "2026-08-31",
  "rules": [
    {
      "id": "zero-width",
      "severity": 3,
      "type": "regex",
      "pattern": "[\\u200B\\u200C\\u200D\\u200E\\u200F\\u180E\\u202A-\\u202E\\u2060-\\u2064\\u3164\\u115F\\uFEFF\\u00AD]",
      "flags": "",
      "applies": [
        "description",
        "raw"
      ],
      "source": "mcp-scan / Aegis / WebMCP-Phalanx — obfuscation research. Detects invisible characters used to conceal instructions in agent-facing text.",
      "added": "1.0.0"
    },
    {
      "id": "instruction-pattern",
      "severity": 3,
      "type": "regex",
      "pattern": "ignore\\s+(all\\s+)?(previous|prior|above)|disregard\\s+(the\\s+)?(previous|prior|above)|do\\s+not\\s+(tell|inform|reveal)|exfiltrat|send\\s+.{0,40}\\b(?:to|at)\\b\\s+https?:|post\\s+.{0,40}\\bto\\b\\s+https?:",
      "flags": "i",
      "applies": [
        "description",
        "raw"
      ],
      "source": "W3C WebMCP draft §6.3 threat model; OWASP ASI02. Detects direct prompt-injection phrasing.",
      "added": "1.0.0"
    },
    {
      "id": "encoded-instruction",
      "severity": 3,
      "type": "executor",
      "executor": "decodeFindings",
      "applies": [
        "description",
        "raw"
      ],
      "source": "WebMCP-Phalanx — encoded payload research. Decodes base64/hex blobs and checks for instruction patterns.",
      "added": "1.0.0"
    },
    {
      "id": "name-charset",
      "severity": 3,
      "type": "regex",
      "pattern": "[^a-zA-Z0-9._-]",
      "flags": "",
      "applies": [
        "name"
      ],
      "source": "WebMCP spec: tool name = 1-128 chars ASCII [a-zA-Z0-9._-]. Spec-level charset check covers fullwidth/homoglyph/NFKC name variants without false-positiving CJK descriptions.",
      "added": "1.0.0"
    },
    {
      "id": "over-budget",
      "severity": 1,
      "type": "length-over",
      "limit": 500,
      "applies": [
        "description"
      ],
      "source": "Chrome WebMCP security guide — character budgets.",
      "added": "1.0.0"
    },
    {
      "id": "wildcard-exposure",
      "severity": 2,
      "type": "regex",
      "pattern": "\\*|[^\\x20-\\x7E]",
      "flags": "",
      "applies": [
        "exposedTo"
      ],
      "source": "Chrome WebMCP security guide — exposedTo restrictions.",
      "added": "1.0.0"
    }
  ]
};
