import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

export type SelectOption = { value: string; label: string; detail?: string; icon?: ReactNode };

/** Portal placement keeps menus usable inside cards, scrolling dialogs and the sidebar. */
export function Select({ options, value, defaultValue, onChange, label, name, placeholder = "Choose an option", disabled = false, searchable = true, compact = false, "aria-invalid": invalid, "aria-describedby": description }: {
  options: SelectOption[]; value?: string; defaultValue?: string; onChange?: (value: string) => void;
  label: string; name?: string; placeholder?: string; disabled?: boolean; searchable?: boolean; compact?: boolean;
  "aria-invalid"?: true; "aria-describedby"?: string;
}) {
  const [local, setLocal] = useState(defaultValue ?? options[0]?.value ?? ""),
    [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0),
    [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 300 });
  const current = value ?? (options.some((option) => option.value === local) ? local : options[0]?.value ?? ""), selected = options.find((option) => option.value === current),
    id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const filtered = options.filter((option) => (option.label + " " + (option.detail ?? "")).toLowerCase().includes(query.toLowerCase()));
  function close() { setOpen(false); trigger.current?.focus(); }
  function choose(next: string) { setLocal(next); onChange?.(next); close(); }
  useEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current!.getBoundingClientRect(), width = Math.min(Math.max(rect.width, compact ? 220 : 280), window.innerWidth - 24),
        below = window.innerHeight - rect.bottom - 12, above = rect.top - 12, height = Math.min(320, Math.max(below, above));
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
        top: below >= Math.min(260, above) ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), maxHeight: height });
    }
    function outside(event: PointerEvent) {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    }
    place(); search.current?.focus();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true); document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); document.removeEventListener("pointerdown", outside); };
  }, [open, compact]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) document.getElementById(id + "-" + active)?.scrollIntoView({ block: "nearest" }); }, [active, open, id]);
  return <div className={"choice " + (compact ? "compact" : "")}>
    {name && <input type="hidden" name={name} value={current} />}
    <button ref={trigger} type="button" className="choice-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-invalid={invalid} aria-describedby={description} disabled={disabled} onClick={(event) => { event.stopPropagation(); setQuery(""); setOpen(!open); }} onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>
      {selected?.icon}<span>{selected?.label ?? placeholder}</span><ChevronDown size={15} />
    </button>
    {open && createPortal(<div ref={popup} className="choice-popup" style={position} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") close();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); setActive((index) => event.key === "Home" ? 0 : event.key === "End" ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      }
      if (event.key === "Enter" && filtered[active]) { event.preventDefault(); choose(filtered[active].value); }
    }}>
      <div className={"choice-search " + (!searchable ? "visually-hidden" : "")}><Search size={15} /><input ref={search} role="combobox" aria-label={"Search " + label.toLowerCase()} aria-controls={id} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={filtered[active] ? id + "-" + active : undefined}
        placeholder={"Search " + label.toLowerCase()} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div role="listbox" id={id} aria-label={label} className="choice-options">
        {filtered.map((option, index) => <button type="button" role="option" aria-selected={current === option.value} tabIndex={-1} id={id + "-" + index} key={option.value}
          className={index === active ? "highlighted" : ""} onPointerMove={() => setActive(index)} onClick={() => choose(option.value)}>
          {option.icon}<span>{option.label}{option.detail && <small>{option.detail}</small>}</span>{current === option.value && <Check size={15} />}
        </button>)}
        {!filtered.length && <p className="choice-empty">No matching options</p>}
      </div>
    </div>, document.body)}
  </div>;
}
