import {
  HASHES,
  ONBOARDINGS,
  USERS,
  UTILS,
  VERIFICATION_DETAILS,
  WALLETS,
} from "../conn/ds_conn";
import {
  email_regex,
  generate_random_string,
  gen_random_int,
} from "../utils/functions";
import { conversion_rates } from "./starter";
import nodemailer from "nodemailer";
import { verification } from "./email";
import fs from "fs";
import { new_notification, platform_user } from "./wallet";

let pending_otps = new Object();
let operating_currencies;

const load_operating_currencies = () => {
  if (!operating_currencies)
    operating_currencies = UTILS.read({ util: "operating_currencies" });

  if (!operating_currencies.length) {
    let operating_currencies = new Array(
      {
        name: "naira",
        icon: "naira_home_page.png",
        flag: "nigeria_flag_rectangle.png",
        alphabetic_name: "NGN",
        util: "operating_currencies",
      },
      {
        name: "euro",
        icon: "euro_icon.png",
        alphabetic_name: "EUR",
        flag: "",
        util: "operating_currencies",
      },
      {
        name: "pound",
        icon: "pound_icon.png",
        alphabetic_name: "POUND",
        flag: "",
        util: "operating_currencies",
      },
      {
        name: "dollar",
        icon: "dollar_icon.png",
        flag: "usa_flag_rectangle.png",
        alphabetic_name: "USD",
        util: "operating_currencies",
      }
    );
    UTILS.write(operating_currencies);
  }
  if (!ONBOARDINGS.readone())
    ONBOARDINGS.write_several(
      new Array(
        {
          icon: "onboarding_1.png",
          main_text: "best rates",
          sub_text:
            "Take advantage of our seamless peer to peer system to get and make International Payments at best rates",
        },
        {
          icon: "onboarding_2.png",
          main_text: "Make International Payments",
          sub_text:
            "Easy way to find International Payments to meet study, tourist and business payments.",
        },
        {
          icon: "onboarding_3.png",
          main_text: "Payment Secured",
          sub_text: "Your transactions are secured on the app with ease",
        }
      )
    );

  !UTILS.readone({ util: UTIL_verification_details }) &&
    UTILS.write({ util: UTIL_verification_details, details: new Array() });

  !UTILS.readone({ util: "purposes" }) &&
    UTILS.write_several(
      new Array(
        { title: "study", util: "purposes" },
        { title: "tourism", util: "purposes" },
        { title: "business", util: "purposes" },
        { title: "remittances", util: "purposes" },
        { title: "others", util: "purposes" }
      )
    );

  return operating_currencies;
};

const onboardings = (req, res) => {
  let onboardings = ONBOARDINGS.read();

  res.json({ data: onboardings, ok: true, message: "ok" });
};

const user_refresh = async (req, res) => {
  let { user } = req.params;
  let result = USERS.readone(user);
  if (!user || !result)
    return res.json({ ok: false, message: "user not found" });
  user = result;
  let wallet = WALLETS.readone(result.wallet);
  if (!wallet) console.error("Wallet not found!!!");

  wallet.conversion_rates = conversion_rates;
  wallet.currencies = load_operating_currencies();

  res.json({ ok: true, message: "ok", data: { user, wallet } });
};

const send_mail = ({
  recipient,
  recipient_name,
  sender_pass,
  sender_name,
  sender,
  subject,
  text,
  html,
  to,
}) => {
  let transporter;

  try {
    transporter = nodemailer.createTransport({
      host: "66.29.137.48" || "udaralinksapp.com",
      port: 465,
      secure: true,
      tls: {
        servername: "udaralinksapp.com",
      },
      auth: {
        user: sender,
        pass: sender_pass,
      },
    });
  } catch (err) {}

  try {
    transporter.sendMail({
      from: `${sender_name} <${sender}>`,
      to: to || `${recipient_name} <${recipient}>`,
      subject,
      text,
      html,
    });
  } catch (error) {
    console.log(error.message);
  }
};

const request_otp = async (req, res) => {
  let { email } = req.body;
  if (!email || !email_regex.test(email))
    return res.json({ ok: false, message: "email field missing" });

  email = email.trim().toLowerCase();
  let user = USERS.readone({ email });

  if (user)
    return res.json({ ok: false, message: "email already used", data: email });

  let code = generate_random_string(6);
  pending_otps[email] = code;

  send_mail({
    recipient: email,
    subject: "[Udara Links] Please verify your email",
    sender: "signup@udaralinksapp.com",
    sender_name: "Udara Links",
    sender_pass: "signupudaralinks",
    html: verification(code),
  });

  res.json({ ok: true, message: "opt sent", data: email });
};

const verify_otp = async (req, res) => {
  let { code, country, country_code, email } = req.body;
  if (!!USERS.readone({ email }))
    return res.json({ ok: false, message: "email already used", data: email });

  email = email.toLowerCase().trim();
  let otp_code = pending_otps[email];
  delete pending_otps[email];

  if (
    String(otp_code).trim() &&
    String(otp_code).trim() === String(code).trim()
  ) {
    let random_string = generate_random_string(gen_random_int(5, 3));
    let user = {
      username: `user-${random_string}`,
      email,
      country,
      country_code,
      created: Date.now(),
      updated: Date.now(),
    };
    let result = USERS.write(user);
    user._id = result._id;
    let wallet = { user: user._id, naira: 0, dollar: 0, pound: 0, euro: 0 };
    result = WALLETS.write(wallet);
    wallet._id = result._id;

    wallet.conversion_rates = conversion_rates;
    wallet.currencies = load_operating_currencies();

    USERS.update(user._id, { wallet: wallet._id });
    user.wallet = wallet._id;

    res.json({
      ok: true,
      message: "verification successful",
      data: { user, wallet },
    });
  } else
    res.json({
      ok: false,
      message: "verification failed",
      data: { email, code },
    });
};

const update_phone = (req, res) => {
  let { phone, verify_later, user, code, country_code } = req.body;

  if (!USERS.readone(user))
    return res.json({ ok: false, message: "user does not exist", data: user });

  let otp_code = pending_otps[phone];
  delete pending_otps[phone];

  if ((otp_code && otp_code === code) || verify_later) {
    USERS.update(user, {
      phone,
      country: country_code.country,
      country_code: country_code.code,
    });

    res.json({ ok: true, message: "user phone updated", data: user });
  }
};

const update_email = (req, res) => {
  let { email, user, code } = req.body;

  if (!USERS.readone(user))
    return res.json({ ok: false, message: "user does not exist", data: user });

  let otp_code = pending_otps[email];
  delete pending_otps[email];

  if (otp_code && otp_code === code) {
    USERS.update(user, { email });

    res.json({ ok: true, message: "user email updated", data: user });
  }
};

const generate_reference_number = () =>
  `${generate_random_string(14, "alnum")}${Date.now()}`;

// const register_persistent_payment_reference = async (user) => {
//   let user_obj = USERS.readone(user);

//   let data = {
//     referenceNumber: generate_reference_number(),
//     phoneNumber: user_obj.phone,
//     firstName: user_obj.firstname,
//     lastName: user_obj.lastname,
//     accountName: `${user_obj.firstname} ${user_obj.lastname}`,
//     accountReference: `${generate_random_string(12)}${generate_random_string(
//       6
//     )}`,
//     callBackUrl: `https://mobile.udaralinksapp.com/paga_deposit/${user}`,
//   };

//   let { response, error } =
//     await paga_collection_client.registerPersistentPaymentAccount(data);
//   let result = PAYMENT_ACCOUNTS.write({
//     user,
//     reference_number: data.referenceNumber,
//     account_reference: data.accountReference,
//     account_number: response.accountNumber,
//   });
//   USERS.update(user_obj._id, {
//     payment_account: result._id,
//     account_number: response.accountNumber,
//   });

//   return response;
// };

const update_password = async (req, res) => {
  let { user, key, new_user } = req.body;
  if (!user || !key)
    return res.json({ ok: false, message: "invalid credentials", data: user });

  HASHES.update_several({ user }, { hash: key });
  let result = HASHES.write({ user, hash: key });
  result &&
    result._id &&
    res.json({ ok: true, message: "update successful", data: user });
};

const logging_in = async (req, res) => {
  let { email, key } = req.body;

  email = email.toLowerCase().trim();

  let user = USERS.readone({ email });
  let email_pass = email_regex.test(email);
  if (!email_pass || !user)
    return res.json({ ok: false, data: "User not found" });
  else if (!key) return res.json({ ok: false, data: "Provide your password" });

  let pass = HASHES.readone({ user: user._id });
  if (!pass || pass.hash !== key)
    return res.json({ ok: false, data: "Invalid password" });

  USERS.update(user._id, { last_login: Date.now() });
  let wallet = WALLETS.readone(user.wallet);
  wallet.conversion_rates = conversion_rates;
  wallet.currencies = load_operating_currencies();

  if (!wallet) return res.json({ ok: false, data: "Cannot fetch wallet" });

  res.json({ ok: true, message: "loggedin", data: { user, wallet } });
};

const UTIL_verification_details = "verification_details";

const unverified_details = (req, res) => {
  let unverified = UTILS.readone({ util: UTIL_verification_details });
  unverified = unverified.details.length
    ? VERIFICATION_DETAILS.read(unverified.details)
    : new Array();

  res.json({ ok: true, message: "unverified details", data: unverified });
};

const get_verification_detail = (req, res) => {
  let { user } = req.params;

  res.json({
    ok: true,
    message: "verification detail",
    data: VERIFICATION_DETAILS.readone({ user }),
  });
};

const verify_account = (req, res) => {
  let { detail } = req.params;

  UTILS.update(
    { util: UTIL_verification_details },
    { details: { $splice: detail } }
  );

  detail = VERIFICATION_DETAILS.update(detail, { verifed: true });
  detail.user &&
    USERS.update(detail.user, {
      verified: true,
      status: "verified",
      phone: detail.phone,
    });

  res.json({ ok: true, message: "verify account", data: detail });
};

const account_verification = (req, res) => {
  let { phone, user, id, id_type, country_code } = req.body;

  let filename = `${generate_reference_number()}.jpg`;
  fs.writeFileSync(
    `${__dirname.split("/").slice(0, -1).join("/")}/Assets/Images/${filename}`,
    Buffer.from(`${id}`, "base64")
  );

  id = filename;

  let result = VERIFICATION_DETAILS.write({
    id,
    id_type,
    user,
    phone,
    country_code,
  });
  UTILS.update(
    { util: UTIL_verification_details },
    { details: { $push: result._id } }
  );
  USERS.update(user, { status: "pending" });

  new_notification({
    user: platform_user,
    title: "Verification Request",
    data: new Array(result._id),
  });

  res.json({ ok: true, message: "account verification", data: { id, user } });
};

export {
  onboardings,
  request_otp,
  verify_otp,
  user_refresh,
  update_password,
  update_phone,
  unverified_details,
  verify_account,
  account_verification,
  update_email,
  logging_in,
  load_operating_currencies,
  operating_currencies,
  generate_reference_number,
  get_verification_detail,
  send_mail,
};
