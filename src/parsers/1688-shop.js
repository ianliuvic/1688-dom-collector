function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function offerIdsFromText(text) {
  const patterns = [
    /detail\.1688\.com\/offer\/(\d{10,13})\.html/gi,
    /detail\.1688\.com\\\/offer\\\/(\d{10,13})\.html/gi,
    /["']offerId["']\s*:\s*["']?(\d{10,13})/gi,
    /\\?["'](?:offerId|id)\\?["']\s*:\s*\\?["']?(\d{10,13})/gi,
    /offerId(?:%22|=|\\?u0026quot;|&quot;)[^0-9]{0,20}(\d{10,13})/gi,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

export async function parse1688Shop(page, networkResponses = []) {
  const dom = await page.evaluate(() => {
    const data = window.pageData ?? {};
    const components = data.components ?? {};
    const modules = Object.values(components).filter((item) => item?.moduleName);
    const header = modules.find((item) => item.moduleName === 'wp_pc_common_header')?.moduleData ?? {};
    const footer = modules.find((item) => item.moduleName === 'wp_pc_common_footer')?.moduleData ?? {};
    const nav = modules.find((item) => item.moduleName === 'wp_pc_common_topnav')?.moduleData ?? {};
    return {
      url: location.href,
      title: document.title,
      bodyText: document.body?.innerText ?? '',
      globalData: data.globalData ?? {},
      header,
      footer,
      navigation: nav.newMenuObj ?? [],
      domOfferUrls: Array.from(document.querySelectorAll('a[href*="detail.1688.com/offer/"]'))
        .map((anchor) => anchor.href),
    };
  });

  const networkOfferIds = networkResponses.flatMap((response) => offerIdsFromText(response.body));
  const domOfferIds = dom.domOfferUrls.flatMap(offerIdsFromText);
  const ignoredIds = new Set([
    String(dom.globalData.sellerId ?? ''), String(dom.globalData.buyerId ?? ''),
    String(dom.globalData.bizId ?? ''), String(dom.globalData.originalBizId ?? ''),
  ]);
  const offerIds = unique([...networkOfferIds, ...domOfferIds]).filter((id) => !ignoredIds.has(id));
  const globalData = dom.globalData;
  const followerMatch = dom.bodyText.match(/粉丝数\s*[：:]\s*([\d,]+)/);
  const establishedDateMatch = dom.bodyText.match(/成立时间\s*[：:]\s*([\d]{4}年\d{1,2}月\d{1,2}日)/);
  const phoneMatch = dom.bodyText.match(/电话\s*[：:]\s*([^\s]+)/);
  const mobileMatch = dom.bodyText.match(/手机\s*[：:]\s*([^\s]+)/);
  const faxMatch = dom.bodyText.match(/传真\s*[：:]\s*([^\s]+)/);
  const contactNameMatch = dom.bodyText.match(/传真\s*[：:][\s\S]{0,220}?([\u4e00-\u9fa5]{2,8})(?:先生|女士)/);
  const offerList = dom.navigation.find((item) => item.id === 'offerlist');
  const newOfferList = dom.navigation.find((item) => item.id === 'newofferlist');

  return {
    schemaVersion: 1,
    pageType: 'shop',
    source: '1688',
    url: dom.url,
    title: dom.title,
    company: {
      name: dom.header.companyName ?? dom.footer.companyName ?? null,
      companyId: dom.header.companyId ?? null,
      sellerId: globalData.sellerId ?? null,
      memberId: globalData.memberId ?? null,
      loginId: globalData.sellerLoginId ?? null,
      sellerType: globalData.sellerType ?? dom.header.sellerType ?? null,
      address: dom.header.addr?.entAddress ?? dom.footer.detailAddress ?? null,
      establishedYear: dom.header.establishedYear ?? null,
      mainCategory: dom.header.mainCate ?? null,
      establishedDate: establishedDateMatch?.[1] ?? null,
    },
    metrics: {
      offerCount: Number(globalData.offerNum) || null,
      followerCount: followerMatch ? Number(followerMatch[1].replaceAll(',', '')) : null,
      serviceScore: dom.header.customerStar ?? null,
      repeatRate: dom.header.byrRepeatRateText ?? null,
      fulfillmentRate: dom.header.lgtFulfillGotRateText ?? null,
      yearsOnPlatform: dom.header.tpYear ?? null,
      businessTags: dom.header.businessTags ?? [],
    },
    session: { buyerIsLogin: globalData.buyerIsLogin === true },
    contact: {
      name: contactNameMatch ? contactNameMatch[1] : null,
      phone: phoneMatch?.[1] && phoneMatch[1] !== '暂无' ? phoneMatch[1] : null,
      mobile: mobileMatch?.[1] && mobileMatch[1] !== '暂无' ? mobileMatch[1] : null,
      fax: faxMatch?.[1] && faxMatch[1] !== '暂无' ? faxMatch[1] : null,
    },
    navigation: dom.navigation.map((item) => ({ name: item.name, id: item.id, url: item.uri })),
    offerListUrl: offerList?.uri ?? null,
    newOfferListUrl: newOfferList?.uri ?? null,
    offerIds,
    offerIdCount: offerIds.length,
    networkSources: unique(networkResponses.map((response) => response.api)),
    parsedAt: new Date().toISOString(),
  };
}
