import { StatusPageIncident, StatusPageResult } from './interfaces/StatusPage';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import { logger } from './logger';
import * as dotenv from 'dotenv';
import { DateTime } from 'luxon';
import fetch from 'node-fetch';
import Keyv from 'keyv';
import fs from 'fs';
import {
	EMBED_COLOR_GREEN,
	EMBED_COLOR_RED,
	EMBED_COLOR_ORANGE,
	EMBED_COLOR_YELLOW,
	EMBED_COLOR_BLACK,
	API_BASE,
} from './constants';

const filePath = './data/data.sqlite';
if (!fs.existsSync(filePath)) {
	fs.writeFileSync(filePath, '');
}
const incidentData: Keyv<DataEntry> = new Keyv(`sqlite://${filePath}`);
dotenv.config();

interface DataEntry {
	messageID: string;
	incidentID: string;
	lastUpdate: string;
	resolved: boolean;
}

const hook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL! });
logger.info(`Starting with ${hook.id}`);

function embedFromIncident(incident: StatusPageIncident): EmbedBuilder {
	const color =
		incident.status === 'resolved' || incident.status === 'postmortem'
			? EMBED_COLOR_GREEN
			: incident.impact === 'critical'
				? EMBED_COLOR_RED
				: incident.impact === 'major'
					? EMBED_COLOR_ORANGE
					: incident.impact === 'minor'
						? EMBED_COLOR_YELLOW
						: EMBED_COLOR_BLACK;

	const affectedNames = incident.components.map((c) => c.name);

	const embed = new EmbedBuilder()
		.setColor(color)
		.setTimestamp(new Date(incident.started_at))
		.setURL(incident.shortlink)
		.setTitle(incident.name)
		.setFooter({ text: incident.id });

	for (const update of incident.incident_updates.reverse()) {
		const updateDT = DateTime.fromISO(update.created_at);
		const timeString = `<t:${Math.floor(updateDT.toSeconds())}:R>`;
		embed.addFields([
			{
				name: `${update.status.charAt(0).toUpperCase()}${update.status.slice(1)} (${timeString})`,
				value: update.body,
			},
		]);
	}

	const descriptionParts = [`• Impact: ${incident.impact}`];

	if (affectedNames.length) {
		descriptionParts.push(`• Affected Components: ${affectedNames.join(', ')}`);
	}

	embed.setDescription(descriptionParts.join('\n'));

	return embed;
}

function isResolvedStatus(status: string) {
	return ['resolved', 'postmortem'].some((stat) => stat === status);
}

async function updateIncident(incident: StatusPageIncident, messageID?: string) {
	const embed = embedFromIncident(incident);
	try {
		const message = await (messageID
			? hook.editMessage(messageID, { embeds: [embed] })
			: hook.send({ embeds: [embed] }));
		logger.debug(`setting: ${incident.id} to message: ${message.id}`);
		await incidentData.set(incident.id, {
			incidentID: incident.id,
			lastUpdate: DateTime.now().toISO(),
			messageID: message.id,
			resolved: isResolvedStatus(incident.status),
		});
	} catch (error) {
		if (messageID) {
			logger.error(`error during hook update on incident ${incident.id} message: ${messageID}\n`, error);
			return;
		}
		console.error(error);
		logger.error(`error during hook sending on incident ${incident.id}\n`, error);
	}
}

async function check() {
	logger.info('heartbeat');
	try {
		const json = (await fetch(`${API_BASE}/incidents.json`).then((r) => r.json())) as StatusPageResult;
		const { incidents } = json;

		for (const incident of incidents.reverse()) {
			const data = await incidentData.get(incident.id);
			if (!data) {
				if (isResolvedStatus(incident.status)) {
					continue;
				}

				logger.info(`new incident: ${incident.id}`);
				void updateIncident(incident);
				continue;
			}

			const incidentUpdate = DateTime.fromISO(incident.updated_at ?? incident.created_at);
			if (DateTime.fromISO(data.lastUpdate) < incidentUpdate) {
				logger.info(`update incident: ${incident.id}`);
				void updateIncident(incident, data.messageID);
			}
		}
	} catch (error) {
		console.error(error);
		logger.error(`error during fetch and update routine:\n`, error);
	}
}

void check();
setInterval(() => void check(), 60_000 * 5);
