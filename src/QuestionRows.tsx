import { Plus, Trash2, MessagesSquare } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { SetupDraft } from "../server/contracts";
import type { useFormFeedback } from "./FormFeedback";

export type QuestionRow = NonNullable<SetupDraft["questionRows"]>[number];
export function QuestionRows({ rows, onChange, disabled, feedback }: { rows: QuestionRow[]; onChange: (rows: QuestionRow[]) => void; disabled: boolean; feedback?: ReturnType<typeof useFormFeedback> }) {
  const selected = rows.filter(row => row.selected && row.text.trim().length >= 3).length;
  const allSelected = rows.length > 0 && rows.every(row => row.selected);
  return <section className="question-editor" aria-label="Questions to check">
    <div className="question-editor-heading"><div><MessagesSquare size={19} /><h2>Your questions</h2><span>{selected} selected</span></div>{rows.length > 0 && <button type="button" className="text-button" disabled={disabled} onClick={() => onChange(rows.map(row => ({ ...row, selected: !allSelected })))}>{allSelected ? "Unselect all" : "Select all"}</button>}</div>
    <div className="question-rows">{rows.map((row, index) => <div className={"question-row " + (!row.selected ? "is-unselected" : "")} key={row.id}>
      <input type="checkbox" aria-label={"Include question " + (index + 1)} checked={row.selected} disabled={disabled} onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, selected: event.target.checked } : item))} />
      <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
      <InlineQuestion value={row.text} label={"Question " + (index + 1)} disabled={disabled} feedback={feedback} onChange={text => onChange(rows.map(item => item.id === row.id ? { ...item, text } : item))} />
      <button type="button" className="icon-button" aria-label={"Delete question " + (index + 1)} disabled={disabled} onClick={() => onChange(rows.filter(item => item.id !== row.id))}><Trash2 size={16} /></button>
    </div>)}</div>
    <button type="button" className="secondary question-add" disabled={disabled || rows.length >= 200} onClick={() => onChange([...rows, { id: crypto.randomUUID(), text: "", selected: true }])}><Plus size={15} />Add a question</button>
  </section>;
}
/** Plain-text editing preserves the caret while allowing long questions to remain readable on small screens. */
function InlineQuestion({ value, label, disabled, feedback, onChange }: { value: string; label: string; disabled: boolean; feedback?: ReturnType<typeof useFormFeedback>; onChange: (text: string) => void }) {
  const field = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (field.current && field.current.textContent !== value) field.current.textContent = value;
  }, [value]);
  useLayoutEffect(() => { if (!value) field.current?.focus(); }, []);
  const commit = (element: HTMLDivElement) => {
    const text = (element.textContent ?? "").replace(/[\r\n]+/g, " ").slice(0, 500);
    if (element.textContent !== text) element.textContent = text;
    onChange(text);
  };
  return <div ref={field} className="inline-question" role="textbox" aria-label={label} aria-multiline="false" aria-disabled={disabled} tabIndex={disabled ? -1 : 0} {...feedback?.field("prompts")} contentEditable={!disabled} suppressContentEditableWarning
    data-placeholder="What would a customer ask?" onInput={event => commit(event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
    onPaste={event => {
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      const text = document.createTextNode(event.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " "));
      range.insertNode(text); range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
      commit(event.currentTarget);
    }} />;
}
