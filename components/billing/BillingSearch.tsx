"use client";

/**
 * BillingSearch
 *
 * Search box for the Billing panel of /dentist/payments and
 * /receptionist/payments.
 *
 * WHY IT EXISTS
 *   getClinicBillsList already accepted a `search` term and ClinicBillingList
 *   already passed it through — there was simply no input anywhere that set it.
 *   The only search box on the page belonged to PaymentFilters, which renders
 *   inside the Payments panel, so switching to Billing left staff scrolling a
 *   clinic-wide list to find one patient.
 *
 *   The URL param is deliberately the same `search` key PaymentFilters uses, so
 *   a term typed in one panel still applies when the other is opened rather than
 *   silently resetting. Same staging behaviour too: the term is applied on
 *   submit, not per keystroke, so the server component re-fetches once.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface BillingSearchProps {
  initialSearch?: string;
}

export function BillingSearch({ initialSearch = "" }: BillingSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(initialSearch);

  function push(term: string) {
    const sp = new URLSearchParams(searchParams.toString());
    // A new search starts at the first page; keeping ?page would land on an
    // empty page whenever the filtered set is shorter than the old one.
    sp.delete("page");
    // Keep the Billing panel open across the navigation.
    sp.set("view", "billing");
    if (term) sp.set("search", term);
    else sp.delete("search");

    startTransition(() => {
      router.push(`${pathname}?${sp.toString()}`);
    });
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        push(search.trim());
      }}
      role="search"
    >
      <div className="relative flex-1 min-w-[16rem] max-w-md">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-disabled"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search bills by patient name or phone…"
          aria-label="Search bills"
          className="pl-9"
        />
      </div>

      <Button type="submit" size="sm" isLoading={isPending}>
        Search
      </Button>

      {initialSearch && (
        <button
          type="button"
          onClick={() => {
            setSearch("");
            push("");
          }}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <X className="h-3 w-3" aria-hidden />
          Clear
        </button>
      )}
    </form>
  );
}
