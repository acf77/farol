# Chat diagrams are Mermaid fenced blocks rendered in the markdown pane

The agent already writes markdown into Chat. We decided diagrams use a standard ` ```mermaid ` fence rather than a new control line, and the existing `MarkdownBody` turns those fences into SVG. The managed-chat contract asks for a diagram of the intended approach in Plan mode, and a diagram of what changed and why after a Build turn that edits files, so the same channel explains intent and outcome.

Considered and rejected: a `FAROL_DIAGRAM` control line (would hide the source from copy and invent a second format); a remote mermaid.ink image (the CSP forbids remote loads, and the diagram would leave the machine).
