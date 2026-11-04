import type { Project } from "./contracts.js";

/** An ask freezes the website's identity with one question and no topics, so it is scored like a check and stored apart from one. */
export function askScope(project: Project, question: string): Project {
  return { ...project, prompts: [question], topics: [] };
}
