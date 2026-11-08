import type { AppIntegration } from './types';

/**
 * The applications the assistant knows about, and precisely what it can do
 * with each one today.
 *
 * Every `assisted` capability below is real: it opens a prefilled draft or
 * the app itself through a documented public URL, and the user completes it.
 * Every `account` capability is listed as unavailable, because reading an
 * inbox or sending on someone's behalf needs an authorised backend that this
 * build does not have. Nothing here is aspirational.
 */
export const APP_INTEGRATIONS: readonly AppIntegration[] = [
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    brandColor: '#25D366',
    glyph: 'chat',
    summary: 'Prepare messages you send yourself.',
    authScopes: ['WhatsApp Business API account', 'Phone number registration'],
    capabilities: [
      {
        id: 'draft',
        label: 'Prepare a message',
        mode: 'assisted',
        note: 'Opens WhatsApp with the text filled in. You choose the chat and press send.',
        launchUrl: 'https://wa.me/',
      },
      {
        id: 'send',
        label: 'Send directly',
        mode: 'account',
        note: 'WhatsApp does not let a third-party app send on your behalf from a personal account.',
      },
      {
        id: 'read',
        label: 'Read chats',
        mode: 'account',
        note: 'Needs the WhatsApp Business API. Personal chats are end-to-end encrypted and not readable.',
      },
    ],
  },
  {
    id: 'instagram',
    name: 'Instagram',
    brandColor: '#E1306C',
    glyph: 'camera',
    summary: 'Open Instagram; messaging needs an account connection.',
    authScopes: ['Instagram Graph API', 'instagram_manage_messages', 'instagram_content_publish'],
    capabilities: [
      {
        id: 'open',
        label: 'Open Instagram',
        mode: 'assisted',
        note: 'Launches Instagram in a new tab or the installed app.',
        launchUrl: 'https://www.instagram.com/',
      },
      { id: 'dms', label: 'Read and reply to DMs', mode: 'account', note: 'Needs a Business or Creator account connected through the Graph API.' },
      { id: 'post', label: 'Post a story', mode: 'account', note: 'Needs content-publishing permission on a connected account.' },
    ],
  },
  {
    id: 'facebook',
    name: 'Facebook',
    brandColor: '#1877F2',
    glyph: 'globe',
    summary: 'Open Facebook; posting needs an account connection.',
    authScopes: ['Facebook Login', 'pages_manage_posts', 'pages_read_engagement'],
    capabilities: [
      {
        id: 'open',
        label: 'Open Facebook',
        mode: 'assisted',
        note: 'Launches Facebook in a new tab or the installed app.',
        launchUrl: 'https://www.facebook.com/',
      },
      { id: 'post', label: 'Post an update', mode: 'account', note: 'Needs a Page connected through Facebook Login.' },
      { id: 'moderate', label: 'Moderate comments', mode: 'account', note: 'Needs page engagement permissions.' },
    ],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    brandColor: '#229ED9',
    glyph: 'send',
    summary: 'Prepare messages you forward yourself.',
    authScopes: ['Telegram Bot API token', 'or MTProto user session'],
    capabilities: [
      {
        id: 'draft',
        label: 'Prepare a message',
        mode: 'assisted',
        note: 'Opens Telegram’s share sheet with the text filled in. You pick the chat.',
        launchUrl: 'https://t.me/share/url',
      },
      { id: 'broadcast', label: 'Post to a channel', mode: 'account', note: 'Needs a bot token and channel admin rights.' },
      { id: 'read', label: 'Read chats', mode: 'account', note: 'Needs an authorised MTProto session.' },
    ],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    brandColor: '#EA4335',
    glyph: 'mail',
    summary: 'Compose mail you send yourself.',
    authScopes: ['Google OAuth', 'gmail.compose', 'gmail.readonly'],
    capabilities: [
      {
        id: 'compose',
        label: 'Compose an email',
        mode: 'assisted',
        note: 'Opens Gmail with a draft ready. You review and press send.',
        launchUrl: 'https://mail.google.com/mail/?view=cm&fs=1',
      },
      { id: 'summarise', label: 'Summarise the inbox', mode: 'account', note: 'Needs Google OAuth with read access, and an AI service.' },
      { id: 'reply', label: 'Draft replies in context', mode: 'account', note: 'Needs read access to the thread being replied to.' },
    ],
  },
  {
    id: 'notes',
    name: 'Notes',
    brandColor: '#F59E0B',
    glyph: 'note',
    summary: 'Saved on this device. No account required.',
    authScopes: [],
    capabilities: [
      { id: 'save', label: 'Save a note by voice', mode: 'local', note: 'Stored on this device and read back to confirm it was written.' },
      { id: 'reminder', label: 'Save a reminder', mode: 'local', note: 'Stored on this device. It cannot ring while the app is closed yet.' },
      { id: 'sync', label: 'Sync across devices', mode: 'account', note: 'Needs an account and a backend; nothing leaves this device today.' },
    ],
  },
  {
    id: 'calendar',
    name: 'Calendar',
    brandColor: '#4cd7f6',
    glyph: 'calendar',
    summary: 'Prepare events you confirm yourself.',
    authScopes: ['Google OAuth', 'calendar.events'],
    capabilities: [
      {
        id: 'event',
        label: 'Prepare an event',
        mode: 'assisted',
        note: 'Opens Google Calendar with a new event filled in. You press save.',
        launchUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE',
      },
      { id: 'agenda', label: 'Read your agenda', mode: 'account', note: 'Needs Google OAuth with calendar read access.' },
    ],
  },
];

export function integrationById(id: string): AppIntegration | undefined {
  return APP_INTEGRATIONS.find((a) => a.id === id);
}
