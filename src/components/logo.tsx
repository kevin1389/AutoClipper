import Link from 'next/link';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-[10px] bg-white">
        <span className="absolute inset-x-[5px] top-[10px] h-[3px] rounded-full bg-black/80" />
        <span className="absolute inset-x-[5px] top-[16px] h-[3px] rounded-full bg-black/50" />
        <span className="absolute right-[6px] bottom-[6px] h-[3px] w-[8px] rounded-full bg-black" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">
        Auto<span className="text-mist-400">Clipper</span>
      </span>
      {!compact && (
        <span className="ml-1 hidden rounded-full border border-ink-600 px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] text-mist-400 sm:inline">
          BETA
        </span>
      )}
    </Link>
  );
}
