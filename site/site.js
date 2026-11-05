const SITE_PAGE = document.body.getAttribute("data-page");
const SITE_JSON = SITE_PAGE === "contributors" ? "/site/contributors.json" : "/site/site.json";
const SITE_THEME_URL = "/site/site.json";

function siteEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function siteApplyBackground(bg) {
  const body = document.body;
  body.style.backgroundColor = bg.color || "#14141f";
  const layers = [];
  if (bg.image) {
    const overlay = typeof bg.imageOverlay === "number" ? bg.imageOverlay : 0;
    if (overlay > 0) layers.push("linear-gradient(rgba(0,0,0," + overlay + "), rgba(0,0,0," + overlay + "))");
    layers.push("url('" + String(bg.image).replace(/'/g, "%27") + "')");
    body.style.backgroundSize = bg.imageSize || "cover";
    body.style.backgroundPosition = bg.imagePosition || "center";
    body.style.backgroundRepeat = "no-repeat";
    body.style.backgroundAttachment = "fixed";
  } else if (bg.gradient) {
    layers.push(bg.gradient);
  }
  if (layers.length > 0) body.style.backgroundImage = layers.join(", ");
}

function siteApplyTheme(theme) {
  const root = document.documentElement;
  const map = { boxColor: "--box", boxBorder: "--box-border", textColor: "--text", headingColor: "--heading", titleColor: "--title", discordColor: "--discord", contributorsColor: "--contrib", boxMaxHeight: "--box-max" };
  for (const key in map) {
    if (theme && theme[key]) root.style.setProperty(map[key], theme[key]);
  }
}

function siteButton(spec, className) {
  const link = siteEl("a", "siteBtn " + className, spec.label);
  link.href = spec.url;
  if (/^https?:\/\//i.test(spec.url)) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

function siteTextBox(section) {
  const box = siteEl("section", "siteBox");
  box.appendChild(siteEl("h2", "", section.heading));
  const scroll = siteEl("div", "siteScroll");
  for (const text of section.paragraphs || []) scroll.appendChild(siteEl("p", "", text));
  box.appendChild(scroll);
  return box;
}

function siteRenderInfo(data, root) {
  const bar = siteEl("header", "siteBar");
  bar.appendChild(siteButton(data.discord, "discord"));
  bar.appendChild(siteEl("h1", "siteTitle", data.title));
  bar.appendChild(siteButton(data.contributorsButton, "contrib"));
  root.appendChild(bar);
  root.appendChild(siteTextBox(data.summary));
  root.appendChild(siteTextBox(data.about));
  const invite = siteTextBox(data.invite);
  if (data.invite.buttonUrl) {
    const action = siteEl("div", "siteAction");
    action.appendChild(siteButton({ label: data.invite.buttonLabel || data.discord.label, url: data.invite.buttonUrl }, "discord"));
    invite.appendChild(action);
  }
  root.appendChild(invite);
}

function siteRenderContributors(data, root) {
  const bar = siteEl("header", "siteBar");
  bar.appendChild(siteButton(data.backButton, "contrib"));
  bar.appendChild(siteEl("h1", "siteTitle", data.title));
  bar.appendChild(siteButton(data.discord, "discord"));
  root.appendChild(bar);
  const intro = siteEl("section", "siteBox");
  intro.appendChild(siteEl("p", "", data.intro));
  root.appendChild(intro);
  for (const group of data.groups || []) {
    const box = siteEl("section", "siteBox");
    box.appendChild(siteEl("h2", "", group.title));
    const scroll = siteEl("div", "siteScroll");
    if (!group.people || group.people.length === 0) {
      scroll.appendChild(siteEl("p", "siteMuted", data.emptyText));
    }
    for (const person of group.people || []) {
      const row = siteEl("div", "sitePerson");
      let name;
      if (person.link) {
        name = siteEl("a", "sitePersonName", person.name);
        name.href = person.link;
        name.target = "_blank";
        name.rel = "noopener noreferrer";
      } else {
        name = siteEl("span", "sitePersonName", person.name);
      }
      row.appendChild(name);
      if (person.role) row.appendChild(siteEl("span", "sitePersonRole", person.role));
      scroll.appendChild(row);
    }
    box.appendChild(scroll);
    root.appendChild(box);
  }
}

async function siteLoad() {
  const root = document.getElementById("siteRoot");
  try {
    const themeRes = await fetch(SITE_THEME_URL, { cache: "no-cache" });
    const themeData = await themeRes.json();
    siteApplyBackground(themeData.background || {});
    siteApplyTheme(themeData.theme || {});
    const res = SITE_PAGE === "contributors" ? await fetch(SITE_JSON, { cache: "no-cache" }) : themeRes;
    const data = SITE_PAGE === "contributors" ? await res.json() : themeData;
    document.title = data.pageTitle || document.title;
    if (SITE_PAGE === "contributors") siteRenderContributors(data, root);
    else siteRenderInfo(data, root);
  } catch (err) {
    root.textContent = "This page could not be loaded right now.";
  }
}

siteLoad();