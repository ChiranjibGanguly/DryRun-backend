import { config } from '../config.js';

const rupees = (paise) => {
  const n = paise / 100;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
};
const ref = (order) => `#${order.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function itemsTable(order) {
  const rows = order.items
    .map((i) => `<tr><td style="padding:4px 0">${i.quantity} × ${esc(i.title)}</td>
      <td style="padding:4px 0;text-align:right">${rupees(i.lineTotalPaise)}</td></tr>`)
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding-top:8px;border-top:1px solid #ddd">Delivery</td>
        <td style="padding-top:8px;border-top:1px solid #ddd;text-align:right">${order.shippingPaise ? rupees(order.shippingPaise) : 'Free'}</td></tr>
    <tr><td><b>Total</b></td><td style="text-align:right"><b>${rupees(order.totalPaise)}</b></td></tr></table>`;
}

const itemsText = (order) =>
  `${order.items.map((i) => `  ${i.quantity} × ${i.title} – ${rupees(i.lineTotalPaise)}`).join('\n')}
  Delivery – ${order.shippingPaise ? rupees(order.shippingPaise) : 'Free'}
  Total – ${rupees(order.totalPaise)}`;

const addressText = (a) =>
  [a?.name, a?.line1, a?.line2, `${a?.city}, ${a?.state} ${a?.pincode}`, a?.phone && `Phone: ${a.phone}`]
    .filter(Boolean).join('\n  ');

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f3f2ec;font-family:Arial,sans-serif;color:#2f2f2f">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <h2 style="font-family:Georgia,serif;margin:0 0 4px">Pustakalay</h2>
    <div style="background:#fff;border-radius:8px;padding:24px;margin-top:12px">
      <h3 style="margin-top:0">${esc(title)}</h3>${bodyHtml}
    </div>
    <p style="font-size:12px;color:#757575">You are receiving this because you ordered from Pustakalay.</p>
  </div></body></html>`;
}

const orderLink = (order) => `${config.shopUrl}/orders/${order.id}`;

/** Sent when a COD order is placed or an online order is paid. */
export function orderConfirmationEmail(order, user) {
  const cod = order.paymentMethod === 'cod';
  const subject = `Order ${ref(order)} confirmed`;
  const payLine = cod
    ? `Please keep ${rupees(order.totalPaise)} ready – you pay in cash on delivery.`
    : `We have received your payment of ${rupees(order.totalPaise)}.`;
  const text = `Hi ${user.name},

Thank you for your order ${ref(order)}. ${payLine}

${itemsText(order)}

Delivering to:
  ${addressText(order.address)}

See your order: ${orderLink(order)}

Pustakalay`;
  const html = layout(`Thank you, ${user.name}!`, `
    <p>Your order <b>${ref(order)}</b> is confirmed. ${esc(payLine)}</p>
    ${itemsTable(order)}
    <p style="margin-top:16px"><b>Delivering to</b><br>${esc(addressText(order.address)).replace(/\n\s*/g, '<br>')}</p>
    <p><a href="${orderLink(order)}" style="background:#2f2f2f;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none">View your order</a></p>`);
  return { to: user.email, subject, text, html };
}

export function orderShippedEmail(order, user, { courier, trackingNumber } = {}) {
  const tracking = [courier, trackingNumber].filter(Boolean).join(' – ');
  const subject = `Order ${ref(order)} is on its way`;
  const cod = order.paymentMethod === 'cod' && order.paymentStatus !== 'paid';
  const text = `Hi ${user.name},

Good news: your order ${ref(order)} has been shipped.${tracking ? `\nTracking: ${tracking}` : ''}${cod ? `\nPlease keep ${rupees(order.totalPaise)} ready for the delivery person.` : ''}

${itemsText(order)}

See your order: ${orderLink(order)}

Pustakalay`;
  const html = layout('Your books are on the way', `
    <p>Your order <b>${ref(order)}</b> has been shipped.</p>
    ${tracking ? `<p><b>Tracking:</b> ${esc(tracking)}</p>` : ''}
    ${cod ? `<p>Please keep <b>${rupees(order.totalPaise)}</b> ready for the delivery person.</p>` : ''}
    ${itemsTable(order)}
    <p style="margin-top:16px"><a href="${orderLink(order)}">View your order</a></p>`);
  return { to: user.email, subject, text, html };
}

export function orderCancelledEmail(order, user, { byCustomer }) {
  const subject = `Order ${ref(order)} cancelled`;
  const why = byCustomer ? 'As you asked, we have cancelled your order' : 'We had to cancel your order';
  const text = `Hi ${user.name},

${why} ${ref(order)}. You have not been charged.

${itemsText(order)}

If you have questions, just reply to this email.

Pustakalay`;
  const html = layout('Order cancelled', `
    <p>${why} <b>${ref(order)}</b>. You have not been charged.</p>${itemsTable(order)}
    <p style="margin-top:16px">If you have questions, just reply to this email.</p>`);
  return { to: user.email, subject, text, html };
}
