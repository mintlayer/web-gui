import { safeExternalUri } from '@/lib/safe-uri';

/**
 * Render a chain-supplied URI as an external link when (and only when) it
 * resolves to a safe https: target; otherwise render plain text.
 */
export default function SafeExternalLink({ uri, className }: { uri: string; className?: string }) {
  const href = safeExternalUri(uri);
  if (!href) {
    return <span className={className}>{uri}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={className}>
      {uri}
    </a>
  );
}
