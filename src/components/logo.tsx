import Link from 'next/link';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <img
        src="/Autoclipperlogo.png?v=42914c3d"
        alt=""
        aria-hidden="true"
        width={1080}
        height={1080}
        loading="eager"
        decoding="async"
        draggable={false}
        className="block h-10 w-auto shrink-0 object-contain sm:h-12"
      />
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
