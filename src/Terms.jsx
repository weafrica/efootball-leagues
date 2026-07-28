import React, { useState } from "react";
import {
  ArrowLeft, ChevronDown, Shield, Scale, Wallet, Camera, AlertTriangle,
  Lock, Users, Ban, RefreshCw, Mail, FileText, Facebook,
} from "lucide-react";

// ════════════════════════════════════════════════════════════════════
// TERMS & CONDITIONS — content configuration.
// Edit the constants below as the real business details are finalised;
// the layout and section components underneath don't need to change.
// ════════════════════════════════════════════════════════════════════

export const TERMS_VERSION = "1.0";
export const TERMS_LAST_UPDATED = "28 July 2026";
export const TERMS_ENTITY_NAME = "We Africa";
export const TERMS_BRAND_NAME = "WeAfrica's Matchday";
export const TERMS_JURISDICTION = "Republic of South Africa";
export const TERMS_SUPPORT_WHATSAPP = "+27694362789";
export const TERMS_SUPPORT_EMAIL = "support@weafrica.co.za";
export const TERMS_ORGANIZER_FEE_PCT = "5%";

// ════════════════════════════════════════════════════════════════════

function Section({ id, icon: Icon, title, summary, defaultOpen, children, c, openId, setOpenId }) {
  const open = openId === id;
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: c.border, background: c.surface }}>
      <button onClick={() => setOpenId(open ? null : id)} className="w-full flex items-start gap-3 px-4 py-3.5 text-left">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{ background: c.surfaceHover, color: c.accent }}>
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-body font-semibold text-sm">{title}</div>
          {summary && !open && <div className="font-body text-xs mt-0.5 truncate" style={{ color: c.textFaint }}>{summary}</div>}
        </div>
        <ChevronDown size={16} className="shrink-0 mt-1 transition-transform" style={{ color: c.textFaint, transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="px-4 pb-4 -mt-1 font-body text-sm leading-relaxed space-y-2.5" style={{ color: c.textDim }}>
          {children}
        </div>
      )}
    </div>
  );
}

function P({ children }) { return <p>{children}</p>; }
function Li({ children }) { return <li className="ml-4 list-disc">{children}</li>; }
function Ul({ children }) { return <ul className="space-y-1.5">{children}</ul>; }
function Strong({ children, c }) { return <strong style={{ color: c.text }}>{children}</strong>; }

export default function TermsPage({ c, onBack, standalone }) {
  const [openId, setOpenId] = useState("intro");

  const sectionProps = { c, openId, setOpenId };

  return (
    <div className="pt-8 pb-14">
      <div className="flex items-center justify-between mb-5">
        {onBack ? (
          <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}>
            <ArrowLeft size={15} /> Back
          </button>
        ) : <span />}
      </div>

      <div className="mb-6">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-3" style={{ background: c.green }}>
          <Scale size={22} color={c.accent} />
        </div>
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none mb-2">Terms &amp; Conditions</h1>
        <p className="font-body text-sm" style={{ color: c.textDim }}>
          These Terms &amp; Conditions ("Terms") govern your use of {TERMS_BRAND_NAME} (the "Platform", "we", "us", "our"),
          operated by {TERMS_ENTITY_NAME}. By creating an account, joining a league, or otherwise using the Platform,
          you agree to be bound by these Terms.
        </p>
        <p className="font-mono text-[10px] uppercase tracking-wider mt-3" style={{ color: c.textFaint }}>
          Version {TERMS_VERSION} · Last updated {TERMS_LAST_UPDATED}
        </p>
      </div>

      <div className="space-y-2.5">

        <Section id="intro" icon={FileText} title="1. Acceptance of these Terms"
          summary="Using the Platform means you've read, understood and agreed to these Terms." {...sectionProps}>
          <P>By registering for, accessing, or using {TERMS_BRAND_NAME} in any way — including browsing as a guest,
            creating an account, joining a league, or making a payment — you confirm that you have read, understood,
            and agree to be legally bound by these Terms and by our handling of your information as described in
            the <Strong c={c}>Privacy &amp; Data Protection</Strong> section below.</P>
          <P>If you do not agree to these Terms, please do not use the Platform. We may update these Terms from time
            to time; see <Strong c={c}>Changes to these Terms</Strong> for how we handle that.</P>
        </Section>

        <Section id="eligibility" icon={Users} title="2. Eligibility"
          summary="You must be 18 or older and able to enter a binding agreement." {...sectionProps}>
          <Ul>
            <Li>You must be at least <Strong c={c}>18 years old</Strong> to create an account, join a cash league, or
              make or receive any payment on the Platform. Younger users may not use the Platform at all, in line with
              Meta/Facebook's own platform requirements where the Platform is accessed via a Facebook or Instagram link.</Li>
            <Li>You must have the legal capacity to enter into a binding agreement under the laws of {TERMS_JURISDICTION}
              or the country you're accessing the Platform from.</Li>
            <Li>You are responsible for ensuring your use of the Platform, including participation in cash leagues,
              complies with the laws applicable to you wherever you are located.</Li>
            <Li>We may ask you to verify your age, identity, or payment details at any time, and may suspend your
              account until you do.</Li>
          </Ul>
        </Section>

        <Section id="service" icon={Shield} title="3. What the Platform is (and isn't)"
          summary="A community league-management tool for eFootball players — not a bank, bookmaker, or Facebook product." {...sectionProps}>
          <P>{TERMS_BRAND_NAME} lets players organize, join, and run eFootball leagues, ladders, and challenges: fixture
            generation, results tracking, standings, and — for leagues that choose to run one — a private cash prize
            pool contributed to by that league's own members.</P>
          <Ul>
            <Li>{TERMS_BRAND_NAME} is a <Strong c={c}>skill-based competition and league-management platform</Strong>,
              not a bookmaker, casino, or betting operator. Outcomes are determined entirely by the players' own
              eFootball match results, not by chance or by any odds we set.</Li>
            <Li>We are not a bank, payment processor, or holder of client funds in a regulated sense. Where a league
              runs a cash pool, funds move directly between members and the league organizer as described in
              <Strong c={c}> Cash Leagues, Entry Fees &amp; Prize Pools</Strong> below.</Li>
            <Li>{TERMS_BRAND_NAME} is an independent, community-run platform. It is <Strong c={c}>not operated,
              sponsored, endorsed, administered by, or in any way affiliated with Facebook, Instagram, Meta
              Platforms, Inc., or any of their affiliates</Strong>, even if you found us through a Facebook or
              Instagram page or link. Any questions, comments, or complaints about the Platform must be directed to
              us, not to Meta or Facebook.</Li>
          </Ul>
        </Section>

        <Section id="account" icon={Lock} title="4. Your account"
          summary="Keep your login and phone number accurate — other players use them to reach you." {...sectionProps}>
          <Ul>
            <Li>You're responsible for the accuracy of your profile — including your eFootball username and phone
              number — and for keeping your login credentials confidential.</Li>
            <Li>You're responsible for all activity that happens under your account. Tell us immediately (see
              <Strong c={c}> Contact Us</Strong>) if you suspect unauthorised access.</Li>
            <Li>One account per person. Creating multiple accounts to gain an unfair advantage in a cash league,
              ladder, or challenge is a breach of these Terms and may result in forfeiture of any related prize
              money and permanent suspension.</Li>
            <Li>We may use Google Sign-In and other third-party identity providers to authenticate you; your use of
              those providers is also subject to their own terms.</Li>
          </Ul>
        </Section>

        <Section id="cash-leagues" icon={Wallet} title="5. Cash leagues, entry fees & prize pools"
          summary="Members set their own entry fee; the pool is split by finishing position, minus our flat organizer share." {...sectionProps}>
          <P>Some leagues are "cash leagues": members choose their own entry fee within the range the league allows,
            pay it in before the league starts, and compete for a prize pool made up of everyone's contributions.</P>
          <Ul>
            <Li><Strong c={c}>Entry fees</Strong> are set by each member within the league's configured range and
              currency (South African Rand). Fees are paid directly to the league organizer via the payment
              method the league displays (typically bank transfer) — the Platform itself never holds your money.</Li>
            <Li><Strong c={c}>Organizer share.</Strong> A flat {TERMS_ORGANIZER_FEE_PCT} of the total approved pool is
              reserved for the person organizing the league, regardless of how much any individual member
              contributed. The remaining pool is what gets paid out as prizes.</Li>
            <Li><Strong c={c}>Prize split</Strong> depends on the league's format: round-robin-style formats
              (single/double round robin, survivor, groups+knockout) pay 1st/2nd/3rd place a 55%/25%/15% share of
              the remaining pool; knockout formats pay the champion and runner-up 75%/20%. Each place's payout is
              further scaled by how much that member personally contributed, so someone who paid a larger entry
              fee receives a proportionally larger share of their place's prize.</Li>
            <Li><Strong c={c}>Payment verification.</Strong> Entry fee payments are marked "pending" until the league
              organizer or an admin confirms receipt. You are not considered entered, and are not eligible for any
              prize, until your payment is approved. We rely on the information and proof you and the organizer
              provide and are not able to independently verify every bank transfer.</Li>
            <Li><Strong c={c}>Payouts</Strong> are arranged directly between the league organizer and the winning
              members once the league concludes and results are finalised. {TERMS_ENTITY_NAME} facilitates the
              league (fixtures, results, standings, and calculating each member's share) but does not itself
              disburse prize money except where we are acting as the organizer of a specific league.</Li>
            <Li>Entry fees are a <Strong c={c}>contribution to that specific league's prize pool</Strong>, not a
              purchase of goods or a guaranteed return — see <Strong c={c}>Refunds &amp; Cancellations</Strong> for
              when a fee may or may not be refunded.</Li>
          </Ul>
        </Section>

        <Section id="results" icon={Camera} title="6. Match results, photo proof & disputes"
          summary="Results need photo proof and admin approval; unresolved fixtures default to a 4-goal loss." {...sectionProps}>
          <Ul>
            <Li>Results must be submitted with <Strong c={c}>photo proof</Strong> (a screenshot of the in-game result)
              before they count. Submissions are reviewed and approved, rejected, or disputed by the league admin
              or the opposing member.</Li>
            <Li>Fixtures not completed by their due date <Strong c={c}>expire</Strong> and are recorded as a loss for
              both/either side as configured by the league, with a conceded scoreline (currently 4 goals), so
              leagues aren't held up by one unplayed match.</Li>
            <Li>If you believe a result was recorded incorrectly, contact your league admin immediately, and our
              support team (see <Strong c={c}>Contact Us</Strong>) if it isn't resolved. Once a league's prize pool
              has been paid out, results are considered final and we cannot reverse a payout.</Li>
            <Li>Submitting fabricated or edited photo proof, colluding on a scoreline, or otherwise manipulating a
              result is prohibited — see <Strong c={c}>Prohibited Conduct</Strong>.</Li>
          </Ul>
        </Section>

        <Section id="refunds" icon={RefreshCw} title="7. Refunds & cancellations"
          summary="Approved entry fees are generally non-refundable once a league starts." {...sectionProps}>
          <Ul>
            <Li>An entry fee that has not yet been approved by the league admin can be withdrawn by contacting the
              admin or our support team before approval.</Li>
            <Li>Once your entry fee is approved and the league has started, it is generally
              <Strong c={c}> non-refundable</Strong> — you've secured a place in that league's prize pool and
              fixture list.</Li>
            <Li>If a league is cancelled before it starts (for example, too few clubs joined), approved entry fees
              are refunded to members via the same payment route they were received on, as arranged with the
              league organizer.</Li>
            <Li>We may, at our discretion, refund or adjust a fee where there's clear evidence of a payment error,
              fraud, or a Platform fault that affected a league's outcome.</Li>
          </Ul>
        </Section>

        <Section id="conduct" icon={Ban} title="8. Prohibited conduct"
          summary="No cheating, collusion, multiple accounts, harassment, or payment fraud." {...sectionProps}>
          <Ul>
            <Li>Using multiple accounts, impersonating another player, or colluding with an opponent to fix a
              result.</Li>
            <Li>Submitting false, edited, or reused photo proof of a match result.</Li>
            <Li>Exploiting bugs in fixture generation, prize calculation, or payment approval instead of reporting
              them.</Li>
            <Li>Harassing, threatening, or abusing other members — including over WhatsApp contact shared through
              the Platform.</Li>
            <Li>Using the Platform for money laundering, or to move funds unrelated to a genuine eFootball
              competition.</Li>
          </Ul>
          <P>Breaching any of the above may result in forfeiture of prize money, removal from a league, or permanent
            suspension of your account, at our discretion and without refund of any entry fee already paid in.</P>
        </Section>

        <Section id="shop" icon={Wallet} title="9. WeAfrica Shop purchases"
          summary="Merchandise orders are a separate transaction with their own checkout and delivery terms." {...sectionProps}>
          <P>The WeAfrica Shop, accessible from within the Platform, sells merchandise (kits, jerseys, and gear)
            separately from league entry fees. Orders are confirmed and fulfilled as described at checkout —
            including payment method, delivery, and any order-specific terms shown there. These league-related
            Terms apply to the Shop only where they don't conflict with terms shown at checkout.</P>
        </Section>

        <Section id="ip" icon={FileText} title="10. Intellectual property"
          summary="Platform content is ours or licensed to us; you keep rights to what you submit." {...sectionProps}>
          <P>The {TERMS_BRAND_NAME} name, logo, design, and platform code are owned by {TERMS_ENTITY_NAME} or our
            licensors. You may not copy, reproduce, or redistribute them without permission. You retain ownership
            of photos and content you submit (such as result screenshots), and grant us a licence to display them
            within the Platform for the purpose of running leagues and resolving disputes.</P>
          <P>"eFootball" and related marks belong to their respective owners (Konami); {TERMS_BRAND_NAME} is an
            independent community platform for organizing play and is not affiliated with or endorsed by Konami.</P>
        </Section>

        <Section id="privacy" icon={Lock} title="11. Privacy & data protection"
          summary="We collect what's needed to run leagues and payments, handled under South Africa's POPIA." {...sectionProps}>
          <P>We collect and process personal information — such as your name, phone number, eFootball username,
            profile photo, and payment/proof-of-payment images — to run the Platform: matching you with opponents,
            verifying league payments, calculating prize splits, and letting other members contact you about a
            fixture.</P>
          <Ul>
            <Li>Your phone number is shown to opponents you're matched against so you can arrange matches over
              WhatsApp. It's hidden from members once their club is eliminated from a cash league.</Li>
            <Li>We process personal information in line with South Africa's Protection of Personal Information Act
              (POPIA) and will not sell your personal information to third parties.</Li>
            <Li>We use third-party service providers to operate the Platform — including Supabase for data storage
              and authentication, and Google Sign-In for login. Where you reach us via a Facebook or Instagram
              link, Meta may separately process data under its own policies before you ever reach our Platform;
              that processing is governed by Meta's own terms, not ours.</Li>
            <Li>You can ask us to access, correct, or delete your personal information by contacting us (see
              <Strong c={c}> Contact Us</Strong>), subject to what we need to retain for legal, dispute-resolution,
              or fraud-prevention purposes (for example, records of an approved cash league payout).</Li>
          </Ul>
        </Section>

        <Section id="facebook" icon={Facebook} title="12. Facebook / Meta platform disclaimer"
          summary="Not sponsored, endorsed, administered by, or associated with Facebook or Meta." {...sectionProps}>
          <P>{TERMS_BRAND_NAME} may be promoted, linked to, or discussed on Facebook or Instagram pages and groups.
            Regardless of how you found us:</P>
          <Ul>
            <Li>{TERMS_BRAND_NAME} is <Strong c={c}>not sponsored, endorsed, administered by, or associated with
              Facebook, Instagram, or Meta Platforms, Inc.</Strong> in any way.</Li>
            <Li>Any information you provide to us through the Platform (as opposed to information you post publicly
              on Facebook or Instagram itself) is provided to {TERMS_ENTITY_NAME}, not to Meta, and is used only as
              described in <Strong c={c}>Privacy &amp; Data Protection</Strong> above.</Li>
            <Li>You release Meta Platforms, Inc. from any claim connected with your use of the Platform, and agree
              that any dispute about the Platform is with {TERMS_ENTITY_NAME}, not with Meta.</Li>
            <Li>Your use of Facebook or Instagram itself remains governed by Meta's own terms of service and data
              policy.</Li>
          </Ul>
        </Section>

        <Section id="disclaimer" icon={AlertTriangle} title="13. Disclaimers & limitation of liability"
          summary={`The Platform is provided "as is"; our liability is limited to the extent the law allows.`} {...sectionProps}>
          <Ul>
            <Li>The Platform is provided "as is" and "as available", without warranties of any kind, whether
              express or implied, including as to availability, accuracy, or fitness for a particular purpose.</Li>
            <Li>We are not responsible for disputes between members outside of the results and payment-approval
              process built into the Platform, for the conduct of individual league organizers, or for delays or
              failures in bank transfers made directly between members.</Li>
            <Li>To the maximum extent permitted by the law of {TERMS_JURISDICTION}, {TERMS_ENTITY_NAME}'s total
              liability to you for any claim arising from your use of the Platform is limited to the organizer fee
              actually retained by us in connection with the league or transaction giving rise to the claim.</Li>
            <Li>Nothing in these Terms limits liability that cannot lawfully be limited, such as liability for
              fraud or wilful misconduct.</Li>
          </Ul>
        </Section>

        <Section id="termination" icon={Ban} title="14. Suspension & termination"
          summary="We can suspend or close accounts that breach these Terms; you can leave a league or delete your account any time." {...sectionProps}>
          <P>We may suspend or terminate your account, or remove you from a league, at any time for breach of these
            Terms, suspected fraud, or abusive behaviour toward other members. You may stop using the Platform, leave
            a league (before it locks entries), or ask us to delete your account at any time, subject to any
            in-progress cash league obligations you've already taken on.</P>
        </Section>

        <Section id="law" icon={Scale} title="15. Governing law & disputes"
          summary={`Governed by the laws of ${TERMS_JURISDICTION}.`} {...sectionProps}>
          <P>These Terms are governed by the laws of {TERMS_JURISDICTION}, without regard to conflict-of-law
            principles. Any dispute arising from your use of the Platform should first be raised with our support
            team (see <Strong c={c}>Contact Us</Strong>) so we can try to resolve it directly before any formal or
            legal process is pursued.</P>
        </Section>

        <Section id="changes" icon={RefreshCw} title="16. Changes to these Terms"
          summary="We may update these Terms; continued use means you accept the changes." {...sectionProps}>
          <P>We may update these Terms as the Platform evolves. We'll update the "Last updated" date above when we
            do, and for material changes we'll make a reasonable effort to flag them in the app. Continuing to use
            the Platform after an update means you accept the revised Terms.</P>
        </Section>

        <Section id="contact" icon={Mail} title="17. Contact us"
          summary="Reach support over WhatsApp or email — not through Facebook or Meta." {...sectionProps}>
          <P>Questions, complaints, or requests about your data or these Terms can be sent to:</P>
          <Ul>
            <Li>WhatsApp: {TERMS_SUPPORT_WHATSAPP}</Li>
            <Li>Email: {TERMS_SUPPORT_EMAIL}</Li>
          </Ul>
          <P>Please contact us directly rather than through Facebook or Instagram — as noted above, we're not
            affiliated with Meta and they cannot resolve Platform issues on our behalf.</P>
        </Section>

      </div>
    </div>
  );
}
