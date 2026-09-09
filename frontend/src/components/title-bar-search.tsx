// The search box in the middle of the window's title row.
//
// **A placeholder, and it says so.** Nothing is wired behind it yet: there is
// no search index in the console, and the host exposes no cross-surface search
// route to call. What this lands is the *place* — one field, in the one band of
// chrome that is on screen from every page, sized and centred so that the row's
// final layout is settled before the behaviour arrives.
//
// It is `disabled` rather than a live input that silently swallows what you
// type. A field that accepts text and answers nothing is worse than an absent
// one: it reads as a working control that has failed, and an operator who types
// into it has been told nothing. Disabled, its `title` says when it will work,
// and a screen reader is told the same thing rather than being offered a text
// box with no results to move to.
//
// It is not a `data-tauri-drag-region`. The attribute is opt-in per element and
// this is a control, so the drag stays on the two spacers either side of it —
// which is what keeps the band grabbable while the field keeps its clicks.

import { Search } from "lucide-react";

/** What the field is for, and why it does not answer yet. */
const SEARCH_PLACEHOLDER = "Search";
const SEARCH_TITLE = "Search is not available yet";

export function TitleBarSearch() {
  return (
    // Takes the middle, whatever the middle is. It was capped at `max-w-md`
    // (28rem), which on a 1440px window left the field a third the width of the
    // gap it sat in and reading as a chip that had drifted to the centre rather
    // than as the row's search. No cap: the two groups beside it are `flex-none`
    // and this is not, so it takes exactly what they leave and gives it back
    // first when the row is crowded. `min-w-0` is what lets it actually shrink
    // rather than flooring the row at its own content width.
    <div className="flex min-w-0 flex-1 justify-center px-3">
      <div className="relative w-full">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          disabled
          data-testid="title-bar-search"
          placeholder={SEARCH_PLACEHOLDER}
          aria-label={SEARCH_PLACEHOLDER}
          title={SEARCH_TITLE}
          className={
            // Taller than the 30px pill beside it and a rung up in type. A
            // field is a thing you aim a cursor at and read your own words
            // back from, which is not what a status pill has to do — matching
            // the pill's height made the one editable control in the row the
            // least substantial-looking thing in it.
            "h-9 w-full rounded-lg border bg-card pr-3 pl-9 text-sm " +
            "text-foreground placeholder:text-muted-foreground " +
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none " +
            // Not greyed to the point of looking broken: it is a real control
            // that is not ready, so it reads as quiet rather than as failed.
            "disabled:cursor-default disabled:opacity-70"
          }
        />
      </div>
    </div>
  );
}
