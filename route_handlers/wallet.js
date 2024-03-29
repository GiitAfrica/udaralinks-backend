import axios from "axios";
import {
  BANK_ACCOUNTS,
  CHATS,
  DISPUTES,
  FIAT_ACCOUNTS,
  LOGS,
  MESSAGES,
  MY_OFFERS,
  NOTIFICATIONS,
  OFFERS,
  OFFER_NEED,
  ONSALE,
  TRANSACTIONS,
  USERS,
  UTILS,
  WALLETS,
} from "../conn/ds_conn";
import { api_key, client_id, paga_collection_client, password } from "../Udara";
import {
  generate_reference_number,
  load_operating_currencies,
  operating_currencies,
} from "./entry";

import sha512 from "js-sha512";
import { generate_random_string } from "../utils/functions";

const COMMISSION = 0.995;

const platform_wallet = `wallets~platform_wallet~3000`;
const platform_user = `users~platform_user~3000`;

let acceptable_payment_method = "BANK_TRANSFER";

const request_account_details = async (req, res) => {
  let { user, amount } = req.body;

  user = USERS.readone(user);
  let { email, _id } = user;

  let response = await paga_collection_client.paymentRequest({
    referenceNumber: generate_reference_number(),
    amount,
    callBackUrl: `https://mobile.udaralinksapp.com/paga_deposit/${_id}`,
    currency: "NGN",
    isAllowPartialPayments: false,
    isSuppressMessages: true,
    payee: { name: "Admin" },
    payer: {
      name: `${_id}`,
      email: email.trim().toLowerCase(),
    },
    payerCollectionFeeShare: 1.0,
    recipientCollectionFeeShare: 0.0,
    paymentMethods: [acceptable_payment_method],
  });

  let account_details;

  if (!response.error) {
    response = response.response;
    account_details = response.paymentMethods.find(
      (method) => method.name === acceptable_payment_method
    );
    account_details = {
      account_number: account_details.properties.AccountNumber,
      bank: "paga",
    };
    res.json({
      ok: true,
      message: "account details generated",
      data: account_details,
    });
  } else
    res.json({
      ok: false,
      data: {
        message: "could not generate account details at this time",
        reason: response.response.statusMessage,
      },
    });
};

const new_notification = (user, title, data, metadata) => {
  NOTIFICATIONS.write({
    user,
    title,
    data,
    metadata,
  });
  USERS.update(user, { new_notification: { $inc: 1 } });
};

const create_transaction = ({
  title,
  wallet,
  user,
  debit,
  from_value,
  data,
}) => {
  let transaction = {
    title,
    from_currency: "naira",
    wallet,
    user,
    from_value,
    debit,
    data,
  };

  let res = TRANSACTIONS.write(transaction);
  if (!res) return console.error("Transaction missing");
  transaction._id = res._id;
  transaction.created = res.created;
  transaction.updated = res.updated;

  return transaction;
};

const transactions = (req, res) => {
  let { wallet, reset_pager } = req.body;

  if (!wallet) return res.json({ ok: false, message: "what wallet?" });

  let transactions = TRANSACTIONS.read(
    { from_currency: "naira" },
    {
      limit: 10,
      paging: wallet,
      reset_pager,
      subfolder: wallet,
    }
  );
  res.json({ ok: true, data: transactions });
};

const update_fav_currency = (req, res) => {
  let { wallet, fav_currency } = req.body;
  let result = WALLETS.update(wallet, { fav_currency });

  if (result)
    res.json({ ok: true, message: "update successful", data: wallet });
  else res.json({ ok: false, message: "unable to make update" });
};

const onsale = (req, res) => {
  let { currency, fetch_currencies, user, skip, limit } = req.body;

  let onsale = ONSALE.read(
    {
      currency,
      seller: { $ne: user },
    },
    { skip, limit }
  );

  if (fetch_currencies) {
    onsale = { onsales: onsale };
    onsale.currencies = load_operating_currencies();
  }

  res.json({ ok: true, data: onsale });
};

const paga_deposit = async (req, res) => {
  let { user } = req.params;
  let { paymentAmount, collectionFee, event, statusCode } = req.body;

  LOGS.write({ data: req.body, user, route: "paga deposit" });

  if (statusCode === "0" && event === "PAYMENT_COMPLETE") {
    let amount = paymentAmount - collectionFee;
    user = USERS.readone(user);

    user &&
      topup(
        { body: { value: amount, user: user._id, wallet: user.wallet } },
        { json: () => {} }
      );
  }

  res.end();
};

const topup = async (req, res) => {
  let { value, user, wallet } = req.body;
  if (!Number(value))
    return res.json({ ok: false, message: "invalid transaction value" });

  WALLETS.update(wallet, { naira: { $inc: value } });

  res.json({
    ok: true,
    message: "transaction successful",
    data: {
      ok: true,
      message: "topup",
      transaction: create_transaction({
        wallet,
        user,
        from_value: value,
        title: "topup",
      }),
    },
  });
};

const add_fiat_account = (req, res) => {
  let { account_number, bank_uuid, user, bank_name } = req.body;

  FIAT_ACCOUNTS.write({ user, account_number, bank_uuid, bank_name });
  res.json({ ok: true, message: "bank account appended", data: user });
};

const make_payment = async ({ bank, account_number }, amount) => {
  let referenceNumber = `${generate_random_string(14, "alnum")}${Date.now()}`,
    destinationBankUUID = bank,
    destinationBankAccountNumber = account_number,
    hash = api_key;

  let response;
  try {
    response = await axios({
      url: "https://beta.mypaga.com/paga-webservices/business-rest/secured/depositToBank",
      method: "post",
      headers: {
        "Content-Type": "application/json",
        principal: client_id,
        credentials: password,
        hash: sha512(
          referenceNumber +
            Number(amount).toFixed(2) +
            destinationBankUUID +
            destinationBankAccountNumber +
            hash
        ),
      },
      data: {
        referenceNumber,
        amount: Number(amount).toFixed(2),
        currency: "NGN",
        destinationBankUUID,
        destinationBankAccountNumber,
        remarks: `Udara wallet withdrawal ${amount}`,
      },
    });
    response = response.data;
  } catch (e) {
    console.log(e);
  }

  return { response, reference_number: referenceNumber };
};

const withdraw = async (req, res) => {
  let { user, amount, bank_account, paycheck, wallet } = req.body;
  if (!Number(amount))
    return res.json({ ok: false, message: "invalid transaction amount" });

  wallet = WALLETS.readone(wallet);

  let user_obj = USERS.readone(user);
  if (!user_obj || !wallet) return res.end();

  if (paycheck) {
    if (wallet.profits < Number(amount)) return res.end();
  } else if (wallet.naira < Number(amount)) return res.end();

  let { response, reference_number } = await make_payment(bank_account, amount);

  if ((response && response.responseCode) || !response)
    return res.json({
      ok: false,
      message: "withdrawal failed",
      data: { ok: false },
    });

  WALLETS.update(
    wallet,
    paycheck
      ? { profits: { $dec: Number(amount) } }
      : { naira: { $dec: Number(amount) } }
  );

  res.json({
    ok: true,
    message: "transaction successful",
    data: {
      ok: true,
      message: "topup",
      transaction: create_transaction({
        wallet,
        user,
        from_value: Number(amount),
        title: "withdrawal",
        debit: true,
        reference_number,
      }),
    },
  });
};

const place_sale = (req, res) => {
  let {
    currency,
    value,
    rate,
    offer_terms,
    icon,
    alphabetic_name,
    seller,
    flag,
    minimum_sell_value,
  } = req.body;

  let result = ONSALE.write({
    currency,
    offer_terms,
    rate,
    seller,
    icon,
    value,
    alphabetic_name,
    flag,
    minimum_sell_value,
  });

  res.json({
    ok: true,
    message: "placed sale",
    data: { onsale: true, _id: result._id, created: result.created },
  });
};

const my_sales = (req, res) => {
  let { seller } = req.params;

  let seller_sales = ONSALE.read(
    { seller },
    {
      subfolder:
        operating_currencies && operating_currencies.length
          ? operating_currencies.map((curr) => curr.name)
          : UTILS.read({ util: "operating_currencies" }).map(
              (curr) => curr.name
            ),
    }
  );

  res.json({ ok: true, message: "seller sales", data: seller_sales });
};

const onsale_currency = (req, res) => {
  let { onsale } = req.params;

  let onsale_currency = ONSALE.readone(onsale);
  if (onsale_currency) res.json({ ok: true, data: onsale_currency });
  else res.json({ ok: false, message: "data not found", data: onsale });
};

const transaction_offer = (req, res) => {
  let { offer: offer_id, onsale: onsale_id } = req.body;

  let offer = OFFERS.readone({ _id: offer_id, onsale_id }),
    onsale = ONSALE.readone({ _id: onsale_id, currency: offer.currency });

  res.json({ ok: true, message: "fetched data", data: { offer, onsale } });
};

const remove_sale = (req, res) => {
  let { onsale, currency } = req.body;

  onsale = ONSALE.readone({ _id: onsale, currency });
  if (!onsale) return res.json({ ok: false, message: "data not found" });

  let response = ONSALE.remove(onsale._id, { subfolder: currency });
  if (!response) return res.json({ ok: false, message: "data not found" });

  res.json({
    ok: true,
    message: "removed",
    data: { onsale: onsale._id },
  });
};

const like_sale = (req, res) => {
  let { onsale, currency } = req.body;
  ONSALE.update({ _id: onsale, currency }, { likes: { $inc: 1 } });

  res.json({ ok: true, message: "liked sale", data: onsale });
};

const dislike_sale = (req, res) => {
  let { onsale, currency } = req.body;
  ONSALE.update({ _id: onsale, currency }, { dislikes: { $inc: 1 } });

  res.json({ ok: true, message: "dislike sale", data: onsale });
};

const make_offer = (req, res) => {
  let { amount, offer_rate, offer_need, wallet, currency, user, onsale } =
    req.body;

  let offer = {
    amount,
    offer_rate,
    user,
    onsale,
    currency,
    wallet,
    offer_need,
    status: "pending",
  };
  let result = OFFERS.write(offer);
  offer._id = result._id;
  offer.created = result.created;
  offer.updated = result.updated;

  MY_OFFERS.write({ user, currency, offer: offer._id, onsale });

  let onsale_res = ONSALE.update(
    { _id: onsale, currency },
    { pending: { $inc: 1 } }
  );

  new_notification(
    onsale_res.seller,
    `new offer from ${USERS.readone(user).username}`,
    new Array(onsale, offer._id),
    { currency }
  );

  res.json({ ok: true, message: "offer placed", data: offer });
};

const buyer_offers = (req, res) => {
  let { buyer, skip, limit } = req.body;

  let offers = MY_OFFERS.read({ user: buyer }, { skip, limit });

  let offers_id = new Array(),
    onsale_ids = new Array(),
    currencies = new Array();

  offers.map((offer) => {
    offers_id.push(offer.offer);
    onsale_ids.push(offer.onsale);
    currencies.push(offer.currency || "dollar");
  });

  offers_id = OFFERS.read(offers_id, { subfolder: onsale_ids });
  onsale_ids = ONSALE.read(onsale_ids, { subfolder: currencies });

  offers.map((offer) => {
    offer.offer = offers_id.find((off) => off._id === offer.offer);
    offer.onsale = onsale_ids.find((ons) => ons._id === offer.onsale);
  });

  res.json({ ok: true, message: "buyer offers", data: offers });
};

const offer = (req, res) => {
  let { offer: offer_id, onsale } = req.body;

  let offer_ = OFFERS.readone({ _id: offer_id, onsale });
  offer_
    ? res.json({ ok: true, message: "offer", data: offer_ })
    : res.json({ ok: false, message: "offer not found" });
};

const my_offers = (req, res) => {
  let { onsale, user } = req.body;

  let offers = OFFERS.read({ onsale, user });
  res.json({ ok: true, message: "your offers", data: offers });
};

const onsale_offers = (req, res) => {
  let { onsale, status } = req.params;

  let offers = OFFERS.read({ onsale, status });
  res.json({ ok: true, message: "offers", data: offers });
};

const accept_offer = (req, res) => {
  let { onsale, offer } = req.body;
  let result = OFFERS.update({ _id: offer, onsale }, { status: "accepted" });
  if (result.user._id) result.user = result.user._id;

  forward_message(result.user, result.seller, offer, {
    status: "accepted",
  });

  let onsale_res = ONSALE.update(
    { _id: onsale, currency: result.currency },
    { pending: { $dec: 1 }, accepted: { $inc: 1 } }
  );

  new_notification(
    result.user,
    `offer accepted by ${USERS.readone(onsale_res.seller).username}`,
    new Array(onsale, offer),
    { currency: result.currency }
  );

  result
    ? res.json({ ok: true, message: "Offer accepted", data: offer })
    : res.json({ ok: false });
};

const decline_offer = (req, res) => {
  let { onsale, offer } = req.body;
  let result = OFFERS.update({ _id: offer, onsale }, { status: "declined" });
  if (result.user._id) result.user = result.user._id;

  forward_message(result.user, result.seller, offer, {
    status: "declined",
  });

  let onsale_res = ONSALE.update(
    { _id: onsale, currency: result.currency },
    { pending: { $dec: 1 }, declined: { $inc: 1 } }
  );

  new_notification(
    result.user,
    `offer declined by ${USERS.readone(onsale_res.seller).username}`,
    new Array(onsale, offer),
    { currency: result.currency }
  );

  result
    ? res.json({ ok: true, message: "Offer declined", data: offer })
    : res.json({ ok: false });
};

const remove_offer = (req, res) => {
  let { offer, onsale } = req.body;

  let result = OFFERS.remove({ _id: offer, onsale });
  result && MY_OFFERS.remove({ offer, buyer: result.user });

  ONSALE.update(
    result.onsale,
    { pending: { $dec: 1 } },
    { subfolder: result.currency }
  );

  res.json({ ok: true, message: "offer removed", data: offer });
};

const fulfil_offer = (req, res) => {
  let { offer, buyer, seller, onsale } = req.body,
    timestamp = Date.now();

  let offer_ = OFFERS.update(
    { _id: offer, onsale },
    { status: "awaiting confirmation", timestamp }
  );
  ONSALE.update(
    { _id: onsale, currency: offer_.currency },
    { in_escrow: { $dec: 1 }, awaiting_confirmation: { $inc: 1 } }
  );

  forward_message(seller, buyer, offer, { status: "awaiting confirmation" });

  new_notification(
    buyer,
    `Fulfilled offer by ${USERS.readone(onsale_res.seller).username}`,
    new Array(onsale, offer),
    { currency: offer_.currency }
  );

  res.json({
    ok: true,
    message: "offer fulfilled",
    data: { offer, onsale, timestamp },
  });
};

const forward_message = async (from, to, offer, meta) => {
  let chat = CHATS.readone({ offer });
  if (chat) {
    let message = {
      from,
      to,
      attachment: new Array(offer),
      attachment_meta: meta,
      chat: chat._id,
      offer,
    };
    let result = MESSAGES.write(message);
    message._id = result._id;
    message.created = result.created;
  }
};

const deposit_to_escrow = (req, res) => {
  let { offer, seller, onsale, buyer_wallet } = req.body;
  let offer_ = OFFERS.readone({ _id: offer, onsale });
  let cost = offer_.amount * offer_.offer_rate,
    timestamp = Date.now();

  OFFERS.update({ _id: offer, onsale }, { status: "in-escrow", timestamp });
  let wallet_update = WALLETS.update(buyer_wallet, { naira: { $dec: cost } });

  ONSALE.update(
    { _id: onsale, currency: offer_.currency },
    { in_escrow: { $inc: 1 }, accepted: { $dec: 1 } }
  );
  WALLETS.update({ _id: platform_wallet }, { naira: { $inc: cost } });

  forward_message(offer_.user._id, seller, offer, { status: "in-escrow" });

  new_notification(
    seller,
    `buyer deposited to escrow`,
    new Array(onsale, offer),
    { currency: offer_.currency }
  );

  res.json({
    ok: true,
    message: "deposited to escrow",
    data: {
      offer,
      onsale,
      seller,
      timestamp,
      transaction: create_transaction({
        title: "deposit to escrow",
        wallet: wallet_update && wallet_update._id,
        user: offer_.user._id,
        from_value: offer_.amount * offer_.offer_rate,
        debit: true,
        data: { offer, onsale },
      }),
    },
  });
};

const confirm_offer = (req, res) => {
  let { offer, onsale, seller, seller_wallet } = req.body;

  let offer_ = OFFERS.readone({ _id: offer, onsale });
  let cost = Number(offer_.offer_rate) * Number(offer_.amount);

  OFFERS.update({ _id: offer, onsale }, { status: "completed", timestamp: 0 });

  let wallet_update = WALLETS.update(seller_wallet, {
    naira: { $inc: cost * COMMISSION },
  });
  ONSALE.update(
    { _id: onsale, currency: offer_.currency },
    { awaiting_confirmation: { $dec: 1 }, completed: { $inc: 1 } }
  );

  WALLETS.update(platform_wallet, {
    naira: { $dec: cost },
    profits: { $inc: cost * 0.005 },
  });

  new_notification(
    seller,
    `buyer confirmed transaction successful`,
    new Array(onsale, offer),
    { currency: offer_.currency }
  );

  forward_message(offer_.user._id, seller, offer, { status: "completed" });

  create_transaction({
    title: "Admin Balance",
    wallet: platform_wallet,
    user: platform_user,
    from_value: cost * 0.005,
    data: { offer, onsale },
  });
  create_transaction({
    title: "confirmed offer",
    wallet: platform_wallet,
    user: platform_user,
    from_value: cost,
    debit: true,
    data: { offer, onsale },
  });

  res.json({
    ok: true,
    message: "offer confirmed",
    data: {
      offer,
      onsale,
      seller,
      transaction: create_transaction({
        title: "offer confirmed",
        wallet: wallet_update && wallet_update._id,
        user: wallet_update.user,
        from_value: cost * COMMISSION,
        data: { offer, onsale },
      }),
    },
  });
};

const extend_time = (req, res) => {
  let { offer, onsale } = req.body;
  let timestamp = Date.now();

  OFFERS.update({ _id: offer, onsale }, { timestamp, requested_time: false });

  res.json({
    ok: true,
    message: "time extended",
    data: {
      timestamp,
    },
  });
};

const request_time_extension = (req, res) => {
  let { offer, onsale } = req.body;

  OFFERS.update({ _id: offer, onsale }, { requested_time: true });
  res.json({ ok: true, message: "time requested", data: offer });
};

const offer_in_dispute = (req, res) => {
  let {
    offer,
    initiator,
    onsale,
    prior_offer_status,
    seller,
    buyer,
    title,
    details,
    currency,
  } = req.body;

  let result = DISPUTES.write({
    offer,
    initiator,
    seller,
    prior_offer_status,
    buyer,
    title,
    currency,
    details,
    onsale,
  });
  let offer_ = OFFERS.update(
    { _id: offer, onsale },
    { prior_offer_status, status: "in-dispute" }
  );

  new_notification(
    initiator === buyer ? seller : buyer,
    "Offer in dispute",
    new Array(offer, onsale),
    { currency }
  );

  forward_message(offer_.user._id, seller, offer, { status: "in-dispute" });

  ONSALE.update(
    { _id: onsale, currency: offer_.currency },
    { [prior_offer_status]: { $dec: 1 }, in_dispute: { $inc: 1 } }
  );

  if (result)
    res.json({
      ok: true,
      message: "dispute raised",
      data: { _id: result._id, offer },
    });
  else res.json({ ok: false, message: "couldn't create dispute" });
};

const resolve_dispute = (req, res) => {
  let { offer, onsale } = req.body,
    timestamp = Date.now();

  let offer_ = OFFERS.readone({ _id: offer, onsale });
  if (!offer_) return res.json({ ok: false, message: "offer not found" });

  OFFERS.update(
    { _id: offer, onsale },
    { status: offer_.prior_offer_status, prior_offer_status: "", timestamp }
  );
  let update = ONSALE.update(
    { _id: onsale, currency: offer_.currency },
    {
      [offer_.prior_offer_status.replace("-", "_")]: { $inc: 1 },
      in_dispute: { $dec: 1 },
    }
  );

  let dispute = DISPUTES.readone({ offer });

  dispute &&
    new_notification(
      dispute.initiator === offer_.user._id
        ? update.seller._id || update.seller
        : offer_.user._id,
      "Dispute resolved",
      new Array(offer, onsale),
      { currency: offer_.currency }
    );

  forward_message(offer_.user._id, update.seller, offer, {
    status: offer_.prior_offer_status,
  });

  DISPUTES.remove({ offer });

  res.json({
    ok: true,
    message: "dispute resolved",
    data: { offer, timestamp },
  });
};

const dispute = (req, res) => {
  let { offer } = req.params;

  let dispute = DISPUTES.readone({ offer });
  res.json({ ok: true, message: "offer dispute", data: dispute });
};

const disputes = (req, res) => {
  let { skip, limit } = req.body;
  let disputes = DISPUTES.read(null, {
    skip,
    limit,
  });
  let onsales = ONSALE.read(
    disputes.map((dispute) => dispute.onsale),
    { subfolder: disputes.map((dispute) => dispute.currency) }
  );
  let offers = OFFERS.read(
    disputes.map((dispute) => dispute.offer),
    { subfolder: disputes.map((dispute) => dispute.onsale) }
  );

  disputes = disputes.map((dispute) => {
    let onsale = onsales.find((onsale_) => onsale_._id === dispute.onsale);
    if (onsale) dispute.onsale = onsale;
    let offer = offers.find((offer_) => offer_._id === dispute.offer);
    if (offer) dispute.offer = offer;
    return dispute;
  });

  res.json({ ok: true, message: "disputes", data: disputes });
};

const refund_buyer = (req, res) => {
  let { offer, onsale } = req.body;

  let offer_ = OFFERS.readone({ _id: offer, onsale });
  if (!offer_ || (offer_ && offer_.status !== "in-dispute"))
    return res.json({ ok: false, message: "cannot find offer" });
  let cost = offer_.amount * offer_.offer_rate;

  WALLETS.update(platform_wallet, { naira: { $dec: cost } });
  let wallet_update = WALLETS.update(offer_.user.wallet, {
    naira: { $inc: cost },
  });

  OFFERS.update({ _id: offer, onsale }, { status: "closed" });
  let onsale_update = ONSALE.update(
    { _id: onsale, currency: offer_.currency },
    { in_dispute: { $dec: 1 }, closed: { $inc: 1 } }
  );

  new_notification(
    offer_.user._id,
    `Your escrow deposit for below offer has been refunded`,
    new Array(offer, onsale),
    {
      currency: offer_.currency,
    }
  );

  forward_message(offer_.user._id, onsale_update.seller, offer, {
    status: "closed",
  });

  res.json({
    ok: true,
    message: "buyer refunded",
    data: {
      offer,
      transaction: create_transaction({
        title: "deposit refunded",
        wallet: wallet_update && wallet_update._id,
        user: wallet_update.user,
        from_value: cost,
        data: { offer, onsale },
      }),
    },
  });
};

const get_banks = async (req, res) => {
  let banks;
  try {
    banks = await paga_collection_client.getBanks({
      referenceNumber: generate_reference_number(),
    });
  } catch (e) {}

  banks && !banks.error
    ? res.json({
        ok: true,
        message: "get banks endpoint",
        data: banks.response.banks,
      })
    : res.json({ ok: false, message: "cannot get banks", data: new Array() });
};

const bank_accounts = (req, res) => {
  let { user } = req.params;

  let accounts = BANK_ACCOUNTS.read({ user });

  res.json({ ok: true, message: "user bank accounts", data: accounts });
};

const add_bank_account = (req, res) => {
  let { bank, bank_name, user, wallet, account_number } = req.body;

  let result = BANK_ACCOUNTS.write({ bank, bank_name, user, account_number });
  WALLETS.update(wallet, { bank_accounts: { $inc: 1 } });

  res.json({
    ok: true,
    message: "bank account saved",
    data: { _id: result._id, created: result.created },
  });
};

const remove_bank_account = (req, res) => {
  let { user, account, wallet } = req.body;

  BANK_ACCOUNTS.remove({ user, _id: account });
  WALLETS.update(wallet, { bank_accounts: { $dec: 1 } });

  res.end();
};

const refresh_wallet = (req, res) => {
  let { wallet } = req.params;

  res.json({
    ok: true,
    message: "wallet refreshed",
    data: WALLETS.readone(wallet),
  });
};

const state_offer_need = (req, res) => {
  let { offer_need } = req.body;

  let result = OFFER_NEED.write(offer_need);

  res.json({
    ok: true,
    message: "offer need",
    data: { _id: result._id, created: result.created },
  });
};

export {
  get_banks,
  bank_accounts,
  add_bank_account,
  remove_bank_account,
  state_offer_need,
  transactions,
  place_sale,
  my_sales,
  onsale,
  topup,
  refresh_wallet,
  withdraw,
  onsale_currency,
  remove_sale,
  platform_wallet,
  platform_user,
  update_fav_currency,
  like_sale,
  dislike_sale,
  make_offer,
  offer,
  my_offers,
  onsale_offers,
  accept_offer,
  decline_offer,
  remove_offer,
  deposit_to_escrow,
  fulfil_offer,
  confirm_offer,
  request_time_extension,
  transaction_offer,
  extend_time,
  offer_in_dispute,
  resolve_dispute,
  dispute,
  disputes,
  refund_buyer,
  buyer_offers,
  paga_deposit,
  add_fiat_account,
  new_notification,
  request_account_details,
};
