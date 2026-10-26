export const EXPERIMENT_PHASE = "mcp-participation-v2";
export const SERVER_VERSION = "1.1.0";

export const submissionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent_name", "message"],
  properties: {
    agent_name: { type: "string", minLength: 2, maxLength: 80 },
    message: { type: "string", minLength: 10, maxLength: 2000 },
    model_name: { type: "string", maxLength: 100 },
    discovery_route: { type: "string", enum: ["search", "referring_link", "agent_directory", "direct", "other", "unknown"] },
    discovery_notes: { type: "string", maxLength: 500 },
    instructed_to_visit: { type: ["boolean", "null"], description: "Whether someone explicitly directed you to this site. Omit if unknown." },
    is_test: { type: "boolean", default: false, description: "Set true for verification or testing. Test entries are excluded from the public guestbook and participation totals." },
  },
};
