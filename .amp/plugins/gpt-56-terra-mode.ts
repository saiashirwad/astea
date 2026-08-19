// @amp-agent-mode {"key":"terra","label":"GPT-5.6 Terra"}

import type { PluginAPI } from '@ampcode/plugin'

export default function (amp: PluginAPI) {
	const agent = amp.createAgent({
		model: 'openai/gpt-5.6-terra',
		instructions: "Follow the user's instructions.",
		tools: 'all',
		reasoningEffort: 'high',
		display: { label: 'GPT-5.6 Terra', color: '#10a37f' },
	})

	amp.registerAgentMode({
		key: 'terra',
		label: 'GPT-5.6 Terra',
		description: "Amp's base agent running on GPT-5.6 Terra with all available tools",
		color: '#10a37f',
		agent: agent.definition,
	})
}
