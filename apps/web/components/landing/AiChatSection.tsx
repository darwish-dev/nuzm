import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { landingText } from '../../lib/landing-text';

/**
 * The landing page's AI chat section: what chatting with Nuzm AI can do,, with an animation of the builder flow. The video (public/videos) is an ILLUSTRATIVE animation rendered from
 * design/ai-chat (not a capture of a live session), and its caption says so.
 */
export function AiChatSection({ locale = 'en' }: { locale?: Locale }) {
  const d = landingText(locale);
  return (
    <section id="chat" className="section wrap chat-section" aria-labelledby="chat-title">
      <div className="chat-copy">
        <span className="eyebrow">{d.chatEyebrow}</span>
        <h2 id="chat-title">
          {d.chatTitle1}
          <br />
          <em>{d.chatTitle2}</em>
        </h2>
        <p>{d.chatText}</p>
        <div className="chat-actions">
          <a className="button button-blue" href="/builder/projects">
            {d.chatTry} <Icon name="sparkle" size={16} />
          </a>
          <a className="button button-outline" href="/console">
            {d.chatDashboard}
          </a>
        </div>
      </div>
      <figure className="chat-video">
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster="/videos/nuzm-ai-chat.jpg"
          aria-label={d.chatVideoLabel}
        >
          <source src="/videos/nuzm-ai-chat.mp4" type="video/mp4" />
        </video>
        <figcaption>{d.chatCaption}</figcaption>
      </figure>
    </section>
  );
}
