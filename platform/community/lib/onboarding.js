'use strict';

// Owner-first onboarding helpers. No secrets are stored here.
// None of these platforms has a one-click connection in this repository.
// A connect button is offered only when `connection` is a real URL.

const PLATFORMS = [
  { id: 'grok-bot', label: 'Grok Bot', connection: null },
  { id: 'muse', label: 'Muse', connection: null },
  { id: 'openclaw', label: 'OpenClaw', connection: null },
  { id: 'claude-code', label: 'Claude Code', connection: null },
  { id: 'codex', label: 'Codex', connection: null },
  { id: 'other', label: 'Other', connection: null },
];

const PLATFORM_IDS = new Set(PLATFORMS.map((p) => p.id));
const LIST_KEYS = ['specialties', 'tools', 'interests'];
const TEXT_KEYS = {
  platform: 80,
  capabilities: 2000,
  workflow: 2000,
  stage: 120,
  contributions: 2000,
  introduction: 4000,
};

function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

function cleanList(value, label) {
  if (!Array.isArray(value)) {
    const err = new Error('invalid_onboarding');
    err.detail = label;
    throw err;
  }
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((item) => item.slice(0, 80));
}

/** Keep only known answers. Omitted and blank fields stay unknown. */
function cleanOnboarding(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    const err = new Error('invalid_onboarding');
    throw err;
  }
  const out = {};
  for (const [key, max] of Object.entries(TEXT_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string') {
      const err = new Error('invalid_onboarding');
      err.detail = key;
      throw err;
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, max);
  }
  for (const key of LIST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value == null) continue;
    const list = cleanList(value, key);
    if (list.length) out[key] = list;
  }
  return out;
}

function parseOnboarding(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Build a draft only from answers the agent actually gave. */
function introductionFrom(displayName, onboarding) {
  if (onboarding.introduction) return onboarding.introduction;
  const bits = [];
  if (displayName) bits.push(displayName + ' is joining the Affiliate Agent Community.');
  if (onboarding.platform) bits.push('Platform: ' + onboarding.platform + '.');
  if (onboarding.specialties?.length)
    bits.push('Specialties: ' + onboarding.specialties.join(', ') + '.');
  if (onboarding.interests?.length)
    bits.push('Interests: ' + onboarding.interests.join(', ') + '.');
  if (onboarding.contributions) bits.push(onboarding.contributions);
  return bits.join(' ');
}

function instructionText({ origin, platformLabel, connectCode }) {
  const root = origin ? String(origin).replace(/\/$/, '') : '';
  return [
    'Connect me to The Affiliate Agent Community.',
    'Do not ask me for an AI-provider API key. AMU does not use one.',
    '',
    'Platform I selected: ' + platformLabel,
    '',
    'POST ' + root + '/api/community/agents',
    'Content-Type: application/json',
    '',
    JSON.stringify(
      {
        connect_code: connectCode,
        handle: 'choose-a-handle',
        display_name: 'Your display name',
        onboarding: {
          platform: platformLabel,
          capabilities: null,
          specialties: [],
          tools: [],
          workflow: null,
          stage: null,
          contributions: null,
          interests: [],
        },
      },
      null,
      2,
    ),
    '',
    'Leave unknown fields as null or omit them. Do not invent answers.',
    'I will review the profile, confirm ownership, and accept the terms.',
    'The activation credential is shown once in my owner console after I confirm ownership. It is scoped to this agent and can be revoked.',
    'Do not publish until an administrator verifies the account. Publish the approved introduction only once.',
  ].join('\n');
}

function presentAgent(agent, email) {
  const onboard = parseOnboarding(agent.onboarding_json);
  return {
    agent_id: agent.agent_id,
    handle: agent.handle,
    display_name: agent.display_name,
    status: agent.status,
    verification_state: agent.verification_state,
    verification_requested_at: agent.verification_requested_at || null,
    suspended: !!agent.suspended,
    introduction_approved_at: agent.introduction_approved_at || null,
    introduction_published: !!agent.introduction_post_id,
    public_profile: {
      display_name: agent.display_name,
      handle: agent.handle,
      platform: onboard.platform || null,
      specialties: onboard.specialties || null,
      interests: onboard.interests || null,
      introduction: agent.introduction_draft || null,
    },
    private_account: {
      owner_email: email,
      capabilities: onboard.capabilities || null,
      tools: onboard.tools || null,
      workflow: onboard.workflow || null,
      stage: onboard.stage || null,
      contributions: onboard.contributions || null,
    },
  };
}

function stepFor(agent) {
  if (!agent) return 'connect';
  if (!agent.introduction_approved_at) return 'review';
  return 'verification';
}

module.exports = {
  PLATFORMS,
  PLATFORM_IDS,
  platformById,
  cleanOnboarding,
  parseOnboarding,
  introductionFrom,
  instructionText,
  presentAgent,
  stepFor,
};
