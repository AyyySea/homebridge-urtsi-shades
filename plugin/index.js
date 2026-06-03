'use strict';

const http = require('http');

const PLUGIN_NAME = 'homebridge-urtsi-shades';
const PLATFORM_NAME = 'URTSIShades';

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, URTSIShadesPlatform);
};

/**
 * Normalize a shade config into: { name, channels: [{urtsi, channel}, ...] }
 * Accepts both old single-channel format and new channels[] format.
 */
function normalizeShade(s) {
  if (!s || !s.name) return null;
  if (Array.isArray(s.channels) && s.channels.length > 0) {
    return { name: s.name, channels: s.channels };
  }
  if (s.urtsi && s.channel) {
    return { name: s.name, channels: [{ urtsi: s.urtsi, channel: s.channel }] };
  }
  return null;
}

class URTSIShadesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.host = this.config.host || 'http://127.0.0.1:8181';
    this.transitionTime = this.config.transitionTime || 5000;
    this.rawShades = this.config.shades || [];
    this.accessories = [];

    api.on('didFinishLaunching', () => {
      const normalized = this.rawShades.map(normalizeShade).filter(Boolean);
      this.log.info(`URTSI Shades platform starting. ${normalized.length} shades configured (${normalized.filter(s=>s.channels.length>1).length} combined).`);
      this.shades = normalized;
      this.registerShades();
      this.cleanupStaleAccessories();
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  /**
   * Single-channel shades and combined shades each get a stable UUID so
   * Apple Home rename + room assignments survive plugin upgrades.
   */
  uuidForShade(shade) {
    if (shade.channels.length === 1) {
      const c = shade.channels[0];
      return this.api.hap.uuid.generate(`urtsi-${c.urtsi}-${c.channel}`);
    }
    const sig = shade.channels.map(c => `${c.urtsi}-${c.channel}`).sort().join(',');
    return this.api.hap.uuid.generate(`urtsi-group:${sig}`);
  }

  registerShades() {
    for (const shade of this.shades) {
      const uuid = this.uuidForShade(shade);
      let accessory = this.accessories.find(a => a.UUID === uuid);
      const isNew = !accessory;

      if (isNew) {
        accessory = new this.api.platformAccessory(shade.name, uuid);
        this.log.info(`Adding shade: ${shade.name} -> [${shade.channels.map(c=>c.urtsi+'/'+c.channel).join(', ')}]`);
      } else {
        accessory.displayName = shade.name;
      }

      accessory.context.shade = shade;
      this.setupAccessory(accessory, shade);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }
  }

  cleanupStaleAccessories() {
    const configuredUuids = new Set(this.shades.map(s => this.uuidForShade(s)));
    const stale = this.accessories.filter(a => !configuredUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessories from cache`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter(a => configuredUuids.has(a.UUID));
    }
  }

  setupAccessory(accessory, shade) {
    const serial = shade.channels.map(c => `${c.urtsi}-${c.channel}`).join('+');
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(Characteristic.Model, shade.channels.length > 1 ? 'URTSI II (combined)' : 'URTSI II')
      .setCharacteristic(Characteristic.SerialNumber, serial);

    // --- WindowCovering service ---
    let wc = accessory.getService(Service.WindowCovering)
      || accessory.addService(Service.WindowCovering, shade.name);

    // Optimistic state — RTS is one-way, no position feedback.
    // Default to fully open (100). We keep state in closure scope per accessory.
    let currentPosition = 100;
    let targetPosition = 100;
    let positionState = Characteristic.PositionState.STOPPED;
    let transitionTimer = null;

    wc.getCharacteristic(Characteristic.CurrentPosition).onGet(() => currentPosition);
    wc.getCharacteristic(Characteristic.PositionState).onGet(() => positionState);

    wc.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => targetPosition)
      .onSet(async (value) => {
        // RTS has no intermediate positions — snap to fully open or fully closed.
        // >=50 opens the shade (Up), <50 closes it (Down).
        const snapped = value >= 50 ? 100 : 0;
        const direction = snapped === 100 ? 'U' : 'D';

        // No-op if already there and stopped.
        if (snapped === currentPosition && positionState === Characteristic.PositionState.STOPPED) {
          targetPosition = snapped;
          wc.updateCharacteristic(Characteristic.TargetPosition, snapped);
          return;
        }

        const moving = snapped > currentPosition
          ? Characteristic.PositionState.INCREASING
          : Characteristic.PositionState.DECREASING;

        try {
          await this.sendToAllChannels(shade, direction);
          targetPosition = snapped;
          positionState = moving;
          wc.updateCharacteristic(Characteristic.TargetPosition, snapped);
          wc.updateCharacteristic(Characteristic.PositionState, positionState);
          // CurrentPosition stays at the old value during the transit window —
          // this is what causes Apple Home to render the native Stop button
          // next to the slider while PositionState != STOPPED.

          if (transitionTimer) clearTimeout(transitionTimer);
          transitionTimer = setTimeout(() => {
            currentPosition = snapped;
            positionState = Characteristic.PositionState.STOPPED;
            wc.updateCharacteristic(Characteristic.CurrentPosition, currentPosition);
            wc.updateCharacteristic(Characteristic.PositionState, positionState);
            transitionTimer = null;
          }, this.transitionTime);
        } catch (err) {
          this.log.error(`${shade.name}: ${direction} command failed: ${err.message}`);
        }
      });

    // HoldPosition is what fires when the user taps the native Stop button
    // that Apple Home shows next to the slider during transit.
    wc.getCharacteristic(Characteristic.HoldPosition)
      .onSet(async (value) => {
        if (!value) return;
        if (transitionTimer) {
          clearTimeout(transitionTimer);
          transitionTimer = null;
        }
        try {
          await this.sendToAllChannels(shade, 'S');
          // Freeze at 50 — the physical shade is at some unknown midpoint and
          // 50 is a reasonable HomeKit lie. Target snaps to current so the
          // system isn't reporting "still trying to move".
          currentPosition = 50;
          targetPosition = 50;
          positionState = Characteristic.PositionState.STOPPED;
          wc.updateCharacteristic(Characteristic.CurrentPosition, currentPosition);
          wc.updateCharacteristic(Characteristic.TargetPosition, targetPosition);
          wc.updateCharacteristic(Characteristic.PositionState, positionState);
        } catch (err) {
          this.log.error(`${shade.name}: STOP (HoldPosition) command failed: ${err.message}`);
        }
      });
  }

  /** Fire commands to every channel in the shade. URTSI server handles bus queueing. */
  async sendToAllChannels(shade, direction) {
    const results = await Promise.allSettled(
      shade.channels.map(c => this.sendCommand(c.urtsi, c.channel, direction))
    );
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      throw new Error(`${failures.length}/${shade.channels.length} channel sends failed`);
    }
  }

  sendCommand(unit, channel, direction) {
    return new Promise((resolve, reject) => {
      const target = new URL(this.host);
      const path = `/?urtsi=${unit}&channel=${channel}&direction=${direction}`;
      const req = http.request({
        hostname: target.hostname,
        port: target.port || 80,
        path,
        method: 'POST',
        timeout: 10000   // generous: URTSI server may queue this command
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    });
  }
}
