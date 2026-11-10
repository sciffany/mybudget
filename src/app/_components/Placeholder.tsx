import type { ReactNode } from "react";

export default function Placeholder({
  children,
}: {
  // Title/description are still accepted by callers but no longer rendered,
  // so each sheet uses the full height for its content.
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-10">
      {children ?? (
        <section className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Coming soon
          </p>
          <p className="text-sm text-zinc-500">
            This section isn&apos;t built yet.
          </p>
        </section>
      )}
    </main>
  );
}
