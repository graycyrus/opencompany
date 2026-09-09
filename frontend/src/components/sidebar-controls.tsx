import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A sidebar row at rest: dimmed until you reach for it.
 *
 * The sidebar is standing furniture, on screen behind every view — holding the
 * whole list at full strength makes ten equal-weight rows compete with the
 * content beside them. Hover, keyboard focus, and the active row all come back
 * to full, so nothing is ever dimmed at the moment you are using it.
 */
// `data-active` is a bare boolean attribute on these buttons, not
// `data-active="true"` — match it the same way the sidebar's own styles do.
export const RESTING_ROW =
  "opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 data-active:opacity-100";

/*
 * `SidebarUtilityBar` used to live here — Settings, Feedback and Discord as
 * three labelled rows in the sidebar's footer, plus an Overview row drawn
 * `md:hidden` to cover the width at which the title row dropped its glyph.
 *
 * All four are in the window's title row now, as glyphs
 * (`components/title-bar-utilities.tsx`, and `OverviewButton` beside them).
 * None of the three is a place inside the company, which is what this column
 * enumerates; a footer under the destinations was saying "not one of these" by
 * position, inside the one region whose whole job is to list destinations.
 *
 * Deleted rather than left exported and unrendered: an unused export is a third
 * state — not drawn, not gone, and free to be re-added by someone who does not
 * know why it left. `DISCORD_BLURPLE` and `DISCORD_INVITE_URL` went with it and
 * now live beside the control that draws them.
 */

/**
 * Show or hide the sidebar. A button on the content card's leading seam.
 *
 * ## Why it is not a row (issue #1177)
 *
 * It used to be a `SidebarMenuButton` — full width, icon then label, `h-8`,
 * `bg-sidebar-accent` on hover — sitting directly under the host switcher and
 * directly above Overview. That is the nav row shape exactly, so the eye filed
 * it as the first destination in the list. It is not a destination: everything
 * else in that column takes you somewhere, and this one changes the chrome and
 * leaves you where you are.
 *
 * Colouring it differently would not have fixed that; the shape is what says
 * "row". So it stops using the row primitive altogether and becomes the
 * console's ordinary icon button.
 *
 * ## Why it is not in the sidebar at all
 *
 * Its next home was the sidebar's own header, beside the host switcher. That
 * put the control that *hides* a panel inside the panel it hides: collapsing
 * the column took the button with it, and the rail had to keep a version of it
 * standing in 32px of content box.
 *
 * Both of those are gone now. The switcher moved to the window's title row
 * (`window-title-bar.tsx`) and the header went with it, so this button is
 * rendered from `app-shell.tsx` inside `SidebarInset`, absolutely positioned on
 * the leading border of the content card — `left-(--frame-inset)` puts it at
 * the edge and `-translate-x-1/2` straddles it. It is one control in both
 * states, it points at the edge that moves, and it costs the page no layout.
 * `sidebar-toggle-reachable.spec.ts` pins that placement.
 *
 * It carries its own fill at rest for the same reason: alone on a border, with
 * no neighbours to belong to and no surface behind it, a ghost glyph read as
 * something drawn on the seam rather than as something pressable. See the
 * class list below.
 */
export function SidebarCollapseButton() {
  const { toggleSidebar, state, isMobile } = useSidebar();
  // `state` tracks the DESKTOP open flag; the sheet has its own (`openMobile`).
  // Reading it unguarded labels an open sheet "Expand sidebar" whenever the
  // desktop state happens to be collapsed — which, since issue #1176 stopped
  // the sidebar auto-collapsing, is now a state an operator can leave behind
  // and come back to on a phone.
  //
  // Defence in depth rather than the live path: `app-shell.tsx` gates this
  // control at `md`, which is exactly where `useIsMobile` flips, because
  // treating mobile as not-collapsed also meant a CLOSED sheet got "Collapse
  // sidebar" and the close icon while pressing it opened the sheet. Below `md`
  // the way back is the shell's own `md:hidden` "Toggle sidebar" bar, which
  // reserves its own row instead of floating over the content (issue #1265).
  // The guard stays so a future caller that does mount this on a phone gets the
  // less wrong of the two labels rather than a confident one.
  const collapsed = !isMobile && state === "collapsed";
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            // Primary, not `ghost` — see the fill note on `className` below.
            // Stated as the variant rather than painted over a ghost, so the
            // one button here and the console's other primary buttons keep
            // moving together when the token does.
            variant="default"
            size="icon-sm"
            // The accessible name, and the only name this control has — an
            // icon-only button with no label is otherwise announced as
            // "button". The tooltip says the same words, but a tooltip is a
            // visual affordance and cannot be relied on for the name.
            aria-label={label}
            // Deliberately NO `aria-expanded`, and not an oversight.
            //
            // The name already carries the state: it says "Collapse sidebar"
            // while the column is showing and "Expand sidebar" once it is a
            // rail, so a reader is told what pressing does and, by the change,
            // what happened. `aria-expanded` on top of that announces the
            // state twice ("Expand sidebar, collapsed") — and `ghost` styles
            // the attribute as "the popup under me is open", which is what it
            // means on the dropdown triggers that variant was written for. On
            // this button it painted a pressed chip for as long as the sidebar
            // was open, and Tailwind sorts `aria-expanded:` after `hover:`, so
            // overriding the chip also swallowed the hover feedback. A second
            // channel saying the same thing is not worth either.
            data-testid="sidebar-collapse"
            onClick={toggleSidebar}
            className={cn(
              // The same resting dim as the rows below, reached through the
              // ink's alpha rather than `RESTING_ROW`'s `opacity-60`: opacity
              // dims the whole box, focus ring included, and the ring on an
              // unlabelled button is the only thing saying where the keyboard
              // is. (`RESTING_ROW` also carries `data-active:opacity-100`,
              // which is a nav row's business and never this one's.)
              // A primary FAB, not a tinted one.
              //
              // In the sidebar's header this was one icon among four, and a
              // resting dim kept it from shouting over its neighbours. It now
              // sits alone, centred on the seam between the rail and the
              // content card — no neighbours to belong to and no surface behind
              // it. Ghost weight read there as a stray glyph drawn on the
              // border; `bg-sidebar-accent/70` fixed that but only barely,
              // because the accent IS the column's own hover tint, so at rest
              // the control looked like a row that happened to be hovered and
              // at a glance like nothing at all.
              //
              // Primary settles it: the one button floating over the seam is
              // the one button in the console that owns its own colour. The
              // shadow is what makes it read as floating ABOVE the two surfaces
              // rather than as a chip stamped into the border between them —
              // this is the only control in the shell that sits over the join,
              // and the only one that needs to say so.
              // The fill, the hover and the disabled state all come from the
              // `default` variant now; only the two things that are about
              // sitting on the seam are said here.
              "shrink-0 shadow-md",
              "focus-visible:ring-primary/50",
              // No `group-data-[collapsible=icon]:size-8` any more, and its
              // absence is the point. `group` is on `[data-slot=sidebar]`
              // (`ui/sidebar.tsx`) and this button is no longer inside it, so
              // that variant could never match again — it would have been a
              // class that reads as a collapsed-state size and silently is not.
              // One size in both states, which is what a control on the seam
              // wants: it does not live in the 3rem rail and has no rhythm of
              // nav icons to land on.
            )}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      {/*
        The raw tooltip primitive rather than `SidebarMenuButton`'s `tooltip`
        prop, which renders its content with `hidden={state !== "collapsed"}`.
        That is right for a nav row — expanded, the row already carries its
        label — and wrong here: this button is icon-only in BOTH states, and
        expanded is the state in which a reader has never seen the word.

        `side="right"` in both states, matching every other tooltip in this
        column, and the one side that is clear of the sidebar either way.
      */}
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
