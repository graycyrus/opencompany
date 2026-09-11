import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether a key of this company's own is already stored — changes the verb. */
  replacing: boolean;
  busy: boolean;
  /** Saves the pasted value. Resolves when the write has landed. */
  onSubmit: (key: string) => void;
}

/**
 * Where a TinyHumans key is pasted, now that the page is rows rather than a form.
 *
 * The page it came off carried the field, its label, its two buttons and four
 * paragraphs about them permanently open under the status it described. Almost
 * none of that was being read: an admin arrives to see which account is paying,
 * and pastes a key perhaps twice in the life of a company.
 *
 * So the field moved behind the control that asks for it. What survives the cut
 * is the one thing the control does not say — that this is the **account** key
 * and not the model-provider key on the LLM page, which is the mistake the
 * `tinyhumans/key`-vs-`inference/key` split exists to prevent and the one an
 * admin standing in front of two password fields actually makes.
 *
 * Write-only, like every credential the console handles: the value goes out on
 * `PUT …/credential` and is never returned, so the field opens empty every time
 * and "set" is reported by a flag rather than by a masked value we would have
 * had to receive.
 */
export function AccountKeyDialog({ open, onOpenChange, replacing, busy, onSubmit }: Props) {
  const [key, setKey] = useState("");

  // Cleared whenever the dialog opens or closes. A credential left in component
  // state after a save is a credential sitting in a heap snapshot for no
  // reason, and reopening on the previous paste would let a second Save write a
  // value the operator thinks they have already used.
  useEffect(() => {
    setKey("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{replacing ? "Replace the account key" : "Add an account key"}</DialogTitle>
          <DialogDescription>
            This company&apos;s TinyHumans account key — the identity its agents present when they
            connect Gmail, Slack or anything else, and the account every turn is billed to. Not the
            model-provider key on the LLM page; the two are stored separately on purpose.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(key.trim());
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="company-credential" className="text-xs">
              TinyHumans account key
            </Label>
            <Input
              id="company-credential"
              type="password"
              autoComplete="off"
              placeholder="paste this company's TinyHumans account key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              data-testid="account-key-input"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !key.trim()} data-testid="account-key-save">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {replacing ? "Replace key" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
