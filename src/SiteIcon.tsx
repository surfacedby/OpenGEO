import { useEffect, useState } from "react";

/** The local backend enforces website scope and the saved icon lookup preference. */
export function SiteIcon({
  projectId,
  domain,
  size = 24,
}: {
  projectId: string;
  domain: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [projectId, domain]);
  const initial = domain
    .replace(/^www\./, "")
    .charAt(0)
    .toUpperCase();
  return (
    <span
      className="site-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {!loaded && (
        <svg viewBox="0 0 32 32" width={size} height={size}>
          <rect width="32" height="32" rx="8" fill="#edf3fd" />
          <text
            x="16"
            y="21"
            textAnchor="middle"
            fill="#075cc7"
            fontSize="16"
            fontFamily="Inter, sans-serif"
            fontWeight="600"
          >
            {initial}
          </text>
        </svg>
      )}
      {!failed && (
        <img
          src={`/api/projects/${encodeURIComponent(projectId)}/site-icon?domain=${encodeURIComponent(domain)}`}
          alt=""
          width={size - 6}
          height={size - 6}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setFailed(true);
            setLoaded(false);
          }}
        />
      )}
    </span>
  );
}
