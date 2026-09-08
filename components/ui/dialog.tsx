"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type DialogSize = "sm" | "md" | "lg" | "xl" | "full";

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  /**
   * Near-viewport width, for content that is itself wide and would otherwise
   * have to scroll sideways inside the dialog — the dental chart's 32-tooth
   * arch being the case this was added for.
   */
  full: "max-w-[96rem] w-[96vw]",
};

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Optional dialog title rendered in the header. When omitted, no header title is shown. */
  title?: string;
  /** Optional subtitle rendered under the title. */
  description?: string;
  children: ReactNode;
  /** Controls the dialog width. Defaults to "lg". */
  size?: DialogSize;
  /**
   * When true, the dialog is "busy" (e.g. saving). Backdrop clicks and the
   * Escape key are ignored, and the close button is disabled, so an in-flight
   * submission cannot be interrupted by an accidental close.
   */
  busy?: boolean;
  /** Hide the header entirely (no title bar / close button). */
  hideHeader?: boolean;
}

/**
 * Dialog
 *
 * Reusable centered modal used across DentGrow for inline CRUD forms and
 * read-only detail views. Standardizes the app's modal UX:
 *   - Centered, consistent width, backdrop blur, smooth entrance animation.
 *   - Focus trap + focus restoration for keyboard accessibility.
 *   - Escape key + backdrop click to close (disabled while `busy`).
 *   - Body scroll lock while open.
 *
 * The body scrolls independently so tall forms remain usable on small screens.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = "lg",
  busy = false,
  hideHeader = false,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Escape to close (ignored while busy)
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, busy]);

  // Body scroll lock
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Focus management: move focus into the dialog on open, restore on close.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const id = setTimeout(() => {
        const focusable = panelRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        (focusable ?? panelRef.current)?.focus();
      }, 50);
      return () => clearTimeout(id);
    }
    previouslyFocused.current?.focus?.();
  }, [open]);

  // Simple focus trap
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title ?? "Dialog"}
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-scrim/45 backdrop-blur-[2px]"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full bg-surface rounded-xl border border-border shadow-[0_20px_44px_-12px_rgba(21,25,24,0.20),0_8px_16px_-6px_rgba(21,25,24,0.10)]",
          "max-h-[90vh] max-h-[90dvh] flex flex-col overflow-hidden animate-fade-in-up outline-none",
          SIZE_CLASSES[size]
        )}
      >
        {!hideHeader && (
          <div className="flex items-start justify-between gap-4 px-4 sm:px-6 py-3.5 sm:py-4 border-b border-border shrink-0">
            <div className="min-w-0">
              {title && (
                <h2 className="text-base font-semibold text-text-primary truncate">{title}</h2>
              )}
              {description && (
                <p className="text-xs text-text-secondary mt-0.5">{description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
              className="rounded-lg p-2.5 text-text-secondary hover:text-text-primary hover:bg-surface-muted transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}
