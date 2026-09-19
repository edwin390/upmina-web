interface TwitchPlayerProps {
  channel?: string;
  videoId?: string;
  title?: string;
}

export default function TwitchPlayer({
  channel,
  videoId,
  title = "Twitch player",
}: TwitchPlayerProps) {
  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const source = videoId ? `video=${videoId}` : `channel=${channel}`;
  const src = `https://player.twitch.tv/?${source}&parent=${parent}&muted=true`;

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border border-border-subtle">
      <iframe
        src={src}
        title={title}
        allowFullScreen
        loading="lazy"
        className="h-full w-full"
      />
    </div>
  );
}
