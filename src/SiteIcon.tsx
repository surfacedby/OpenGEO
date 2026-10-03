import { useState } from "react";

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
  return <SiteImage key={projectId + ':' + domain} projectId={projectId} domain={domain} size={size} />;
}

function SiteImage({ projectId, domain, size }: { projectId: string; domain: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className="site-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {!loaded && (
        <svg viewBox="0 0 32 32" width={size} height={size}>
          <rect width="32" height="32" rx="8" fill="#edf3fd" />
          <g fill="none" stroke="#7890b2" strokeWidth="1.5">
            <circle cx="16" cy="16" r="9" />
            <ellipse cx="16" cy="16" rx="4" ry="9" />
            <path d="M7 16h18" />
          </g>
        </svg>
      )}
      {!failed && (
        <img
          src={`/api/projects/${encodeURIComponent(projectId)}/site-icon?domain=${encodeURIComponent(domain)}`}
          alt=""
          width={size - 6}
          height={size - 6}
          loading="lazy"
          style={{ opacity: loaded ? 1 : 0 }}
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
