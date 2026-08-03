/**
 * Re-export surface for clack, so every interactive module imports prompts
 * from one place and the dependency can be swapped without touching wizards.
 */
export { confirm, intro, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
export { assertInteractive, isInteractive, unwrap } from "./tty";
