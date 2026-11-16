/**
 * Blue Origin - Google Ads to Google Sheet (for the Lead Generation dashboard, GOOGLE_ADS_MODE=sheet)
 *
 * What it does: reads this Google Ads account (read-only: it changes nothing in Google Ads) and writes three tabs to the
 * Google Sheet in SHEET_URL, replacing only these tabs on every run:
 *   Ads_Info       account name, customer ID, currency, time zone, when the script last ran
 *   Ads_Campaigns  every campaign: ID, name, status, serving status (ENDED once its end date has passed), type, budget (daily /
 *                  total), shared or not, lifetime cost and results
 *   Ads_Daily      one row per campaign and day for the last DAYS days: cost, impressions, clicks, conversions
 *   Ads_Conversions one row per campaign, day and conversion action: conversions and all conversions. The dashboard counts
 *                  only the action named "Conversion" as leads (GOOGLE_ADS_LEAD_CONVERSION in backend/.env)
 *   Ads_Keywords   per month, campaign, ad group, keyword and match type: cost, impressions, clicks, conversions (Search campaigns)
 *   Ads_SearchTerms per month, campaign and search term: the same figures (Search campaigns)
 *   Ads_Devices    per month, campaign and device: the same figures
 *   Ads_Geo        per month, campaign and region: the same figures
 *   Keywords and search terms exist only for Search-type campaigns: Performance Max campaigns have neither, so those two tabs
 *   stay empty for them. If Google Ads refuses one of these four reports, the others and the main tabs are still written and the
 *   reason is put in Ads_Info as <name>_error, where the dashboard shows it.
 * Only campaigns whose name contains CAMPAIGN_FILTER (any case) are written: the GT team's YASHA campaigns.
 *
 * Set up (once, by someone with access to the Google Ads account):
 *   1. Create a NEW, empty Google Sheet (not the lead sheet). Copy its link into SHEET_URL below.
 *   2. Google Ads -> Tools -> Bulk actions -> Scripts -> + New script. Paste this whole file. Authorise when asked.
 *   3. Press Preview, then Run. Check the tabs appeared in the sheet (Ads_Info, Ads_Campaigns, Ads_Daily, Ads_Conversions, Ads_Keywords, Ads_SearchTerms, Ads_Devices, Ads_Geo).
 *   4. Set Frequency to Hourly.
 *   5. Share the sheet (Viewer) with the dashboard's service account, then put the sheet link in backend/.env as
 *      GOOGLE_ADS_SHEET_URL and set GOOGLE_ADS_MODE=sheet.
 */
var SHEET_URL = 'PASTE_THE_NEW_SHEET_LINK_HERE';
var DAYS = 400; // history kept in Ads_Daily
var CAMPAIGN_FILTER = 'YASHA'; // only campaigns whose name contains this (any case); '' = every campaign

function main() {
  if (SHEET_URL.indexOf('docs.google.com') < 0) throw new Error('Set SHEET_URL to the link of the new Google Sheet first.');
  var ss = SpreadsheetApp.openByUrl(SHEET_URL);
  var acct = AdsApp.currentAccount();
  var tz = acct.getTimeZone();
  var now = new Date();
  var end = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var start = Utilities.formatDate(new Date(now.getTime() - (DAYS - 1) * 86400000), tz, 'yyyy-MM-dd');
  // GAQL: (?i) makes the name match ignore case
  var only = CAMPAIGN_FILTER ? " campaign.name REGEXP_MATCH '(?i).*" + CAMPAIGN_FILTER.replace(/[^A-Za-z0-9 _-]/g, '') + ".*'" : '';

  // campaigns with their budgets and lifetime totals (all statuses, removed ones too)
  var campaigns = [['campaign_id', 'campaign_name', 'status', 'channel_type', 'budget_amount', 'budget_period', 'budget_total_amount',
                    'budget_shared', 'lifetime_cost', 'lifetime_impressions', 'lifetime_clicks', 'lifetime_conversions', 'serving_status']];
  var rows = AdsApp.search(
    'SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, ' +
    'campaign_budget.amount_micros, campaign_budget.period, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, ' +
    'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign' + (only ? ' WHERE' + only : ''));
  while (rows.hasNext()) {
    var r = rows.next();
    var c = r.campaign || {}, b = r.campaignBudget || {}, m = r.metrics || {};
    campaigns.push([String(c.id), c.name || '', c.status || '', c.advertisingChannelType || '',
                    money(b.amountMicros), b.period || '', money(b.totalAmountMicros), String(!!b.explicitlyShared),
                    money(m.costMicros), num(m.impressions), num(m.clicks), num(m.conversions), c.servingStatus || '']);
  }

  // daily figures per campaign
  var daily = [['date', 'campaign_id', 'campaign_name', 'cost', 'impressions', 'clicks', 'conversions']];
  rows = AdsApp.search(
    'SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions ' +
    "FROM campaign WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'" + (only ? ' AND' + only : ''));
  while (rows.hasNext()) {
    var d = rows.next();
    var dc = d.campaign || {}, dm = d.metrics || {};
    daily.push([d.segments.date, String(dc.id), dc.name || '', money(dm.costMicros), num(dm.impressions), num(dm.clicks), num(dm.conversions)]);
  }

  // conversions per conversion action (the dashboard takes the leads from the action named "Conversion")
  var conv = [['date', 'campaign_id', 'campaign_name', 'conversion_action', 'conversions', 'all_conversions']];
  rows = AdsApp.search(
    'SELECT segments.date, campaign.id, campaign.name, segments.conversion_action_name, metrics.conversions, metrics.all_conversions ' +
    "FROM campaign WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'" + (only ? ' AND' + only : ''));
  while (rows.hasNext()) {
    var x = rows.next();
    var xc = x.campaign || {}, xm = x.metrics || {};
    conv.push([x.segments.date, String(xc.id), xc.name || '', x.segments.conversionActionName || '', num(xm.conversions), num(xm.allConversions)]);
  }

  // keywords, search terms, devices and geography by month; one report failing never stops the others
  var errors = {};
  var base = "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'" + (only ? ' AND' + only : '');
  var metricsSql = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions';
  function report(key, headers, query, toRow) {
    var out = [headers];
    try {
      var it = AdsApp.search(query);
      while (it.hasNext()) out.push(toRow(it.next()));
    } catch (e) {
      errors[key] = String(e && e.message ? e.message : e).slice(0, 300);
    }
    return out;
  }
  var tail = function (r) { var m = r.metrics || {}; return [money(m.costMicros), num(m.impressions), num(m.clicks), num(m.conversions)]; };
  var head4 = function (r) { var c = r.campaign || {}; return [r.segments.month, String(c.id), c.name || '']; };
  var keywords = report('keywords', ['month', 'campaign_id', 'campaign_name', 'ad_group', 'keyword', 'match_type', 'cost', 'impressions', 'clicks', 'conversions'],
    'SELECT segments.month, campaign.id, campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ' + metricsSql + ' FROM keyword_view ' + base,
    function (r) { var k = (r.adGroupCriterion || {}).keyword || {}; return head4(r).concat([(r.adGroup || {}).name || '', k.text || '', k.matchType || '']).concat(tail(r)); });
  var terms = report('search_terms', ['month', 'campaign_id', 'campaign_name', 'search_term', 'status', 'cost', 'impressions', 'clicks', 'conversions'],
    'SELECT segments.month, campaign.id, campaign.name, search_term_view.search_term, search_term_view.status, ' + metricsSql + ' FROM search_term_view ' + base,
    function (r) { var t = r.searchTermView || {}; return head4(r).concat([t.searchTerm || '', t.status || '']).concat(tail(r)); });
  var devices = report('devices', ['month', 'campaign_id', 'campaign_name', 'device', 'cost', 'impressions', 'clicks', 'conversions'],
    'SELECT segments.month, segments.device, campaign.id, campaign.name, ' + metricsSql + ' FROM campaign ' + base,
    function (r) { return head4(r).concat([r.segments.device || '']).concat(tail(r)); });
  // geography: regions come back as resource names; their readable names are looked up in batches
  var geo = [['month', 'campaign_id', 'campaign_name', 'region', 'cost', 'impressions', 'clicks', 'conversions']];
  try {
    var geoRows = [], regionIds = {};
    var git = AdsApp.search('SELECT segments.month, campaign.id, campaign.name, segments.geo_target_region, ' + metricsSql + ' FROM geographic_view ' + base);
    while (git.hasNext()) {
      var gr = git.next();
      var rn = gr.segments.geoTargetRegion || '';
      regionIds[rn] = 1;
      geoRows.push(head4(gr).concat([rn]).concat(tail(gr)));
    }
    var regionNames = {}, ids = Object.keys(regionIds).filter(function (x) { return x; });
    for (var i = 0; i < ids.length; i += 100) {
      var list = ids.slice(i, i + 100).map(function (x) { return "'" + x + "'"; }).join(',');
      var nit = AdsApp.search('SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (' + list + ')');
      while (nit.hasNext()) { var gn = nit.next().geoTargetConstant; regionNames[gn.resourceName] = gn.name; }
    }
    geoRows.forEach(function (r) { r[3] = regionNames[r[3]] || r[3]; geo.push(r); });
  } catch (e) {
    errors.geo = String(e && e.message ? e.message : e).slice(0, 300);
  }

  var info = [['key', 'value'],
              ['account_name', acct.getName()],
              ['customer_id', acct.getCustomerId()],
              ['currency', acct.getCurrencyCode()],
              ['time_zone', tz],
              ['updated_at', Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss")],
              ['days', String(DAYS)],
              ['campaign_filter', CAMPAIGN_FILTER]];
  Object.keys(errors).forEach(function (k) { info.push([k + '_error', errors[k]]); });

  writeTab(ss, 'Ads_Info', info);
  writeTab(ss, 'Ads_Campaigns', campaigns);
  writeTab(ss, 'Ads_Daily', daily);
  writeTab(ss, 'Ads_Conversions', conv);
  writeTab(ss, 'Ads_Keywords', keywords);
  writeTab(ss, 'Ads_SearchTerms', terms);
  writeTab(ss, 'Ads_Devices', devices);
  writeTab(ss, 'Ads_Geo', geo);
  Logger.log('Wrote ' + (campaigns.length - 1) + ' campaigns, ' + (daily.length - 1) + ' daily rows and ' + (conv.length - 1) +
             ' conversion rows (' + start + ' to ' + end + ').');
}

// replaces one tab only; everything is written as plain text so dates and IDs are not changed by the sheet
function writeTab(ss, name, values) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  var range = sh.getRange(1, 1, values.length, values[0].length);
  range.setNumberFormat('@');
  range.setValues(values.map(function (row) { return row.map(function (v) { return v === null || v === undefined ? '' : String(v); }); }));
}

function money(micros) { return micros ? (Number(micros) / 1e6).toFixed(2) : ''; }
function num(v) { return v === null || v === undefined ? '' : String(v); }
