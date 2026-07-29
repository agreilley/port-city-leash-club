// Meta (Facebook) Pixel — Port City Leash Club
// Loaded on public marketing pages only. Not present on any
// authenticated portal/admin/walker/dev page.
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1024622867154084');
fbq('track', 'PageView');

// Named helper for firing standard events. Wrapped so a tracking
// failure can never break a form submit or other page behavior.
window.pclcTrack = function(eventName, params) {
  try {
    if (typeof fbq === 'function') { fbq('track', eventName, params); }
  } catch (e) { /* never let tracking break a form submit */ }
};
