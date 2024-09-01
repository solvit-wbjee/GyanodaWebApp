require("dotenv").config();
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import nodemailer from "nodemailer";
import { Request, Response, NextFunction } from "express";
import userModel, { IUser } from "../models/user.model";
import ErrorHandler from "../utils/ErrorHandler";
import { CatchAsyncError } from "../middleware/catchAsyncErrors";
import jwt, { JwtPayload, Secret } from "jsonwebtoken";

import ejs from "ejs";
import path from "path";
import sendMail from "../utils/sendMail";
import {
  accessTokenOptions,
  refreshTokenOptions,
  sendToken,
} from "../utils/jwt";
import { redis } from "../utils/redis";
import {
  getAllUsersService,
  getUserById,
  updateUserRoleService,
} from "../services/user.service";
import cloudinary from "cloudinary";


//SMS Auth Details (Tiliwo)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken)

const sendSMS = async (body: string, to: string) => {
  let formattedNumber = to.replace(/^\+?91/, '');
  formattedNumber = `+91${formattedNumber}`; 
    const msgOptions = {
      
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: formattedNumber,
      body
    };

    try {
      const message = await client.messages.create(msgOptions);
      console.log(`SMS sent successfully: ${message.sid}`);
    } catch (error) {
      console.error('Error sending SMS:', error);
    }
  };


//whatsapp sms
  
const sendWhatsAppMessage = async (body: string, to: string) => {
  const msgOptions = {
    from: 'whatsapp:+14155238886', 
    to: `whatsapp:${to}`,
    body
  };

  try {
    const message = await client.messages.create(msgOptions);
    console.log(`WhatsApp message sent successfully: ${message.sid}`);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
  }
};

// register user
interface IRegistrationBody {
  name: string;
  email: string;
  password: string;
  avatar?: string;
  phone?: string;
  location?: string;
}

export const registrationUser = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email, password,phone,location } = req.body;

      const isEmailExist = await userModel.findOne({ email });
      if (isEmailExist) {
        return next(new ErrorHandler("Email already exist", 400));
      }
      const isPhoneExists = await userModel.findOne({ phone });
      if (isPhoneExists)
      {
        return next(new ErrorHandler("Mobile already exist", 400));
      }
      const user: IRegistrationBody = {
        name,
        email,
        password,
        phone,
        location
      };

      const activationToken = createActivationToken(user);

      const activationCode = activationToken.activationCode;

      const data = { user: { name: user.name }, activationCode };
      const html = await ejs.renderFile(
        path.join(__dirname, "../mails/activation-mail.ejs"),
        data
      );
      
      try {
        await sendMail({
          email: user.email,
          subject: "Activate your account",
          template: "activation-mail.ejs",
          data,
        });
        const smsBody = `Dear ${name}, you have successfully registered.Your Activation code is ${activationCode }.This Activaton Code valid for 5  min. Please Verify your Account to get activated.`;
        await sendSMS(smsBody, phone);

        // Send WhatsApp message
        const whatsappBody = `Dear ${name}, you have successfully registered.Please Verify your Account to get activated`;
        await sendWhatsAppMessage(whatsappBody, phone);
        res.status(201).json({
          success: true,
          message: `Please check your email: ${user.email} and ${user.phone} to activate your account!`,
          activationToken: activationToken.token,
          email: user.email, 
        });
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


interface IActivationToken {
  token: string;
  activationCode: string;
}

export const createActivationToken = (user: any): IActivationToken => {
  const activationCode = Math.floor(1000 + Math.random() * 9000).toString();

  const token = jwt.sign(
    {
      user,
      activationCode,
    },
    process.env.ACTIVATION_SECRET as Secret,
    {
      expiresIn: "5m",
    }
  );

  return { token, activationCode };
};

// activate user
interface IActivationRequest {
  activation_token: string;
  activation_code: string;
}

export const activateUser = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { activation_token, activation_code } =
        req.body as IActivationRequest;

      const newUser: { user: IUser; activationCode: string } = jwt.verify(
        activation_token,
        process.env.ACTIVATION_SECRET as string
      ) as { user: IUser; activationCode: string };

      if (newUser.activationCode !== activation_code) {
        return next(new ErrorHandler("Invalid activation code", 400));
      }

      const { name, email, password,phone,location } = newUser.user;

      const existUser = await userModel.findOne({ email });
      const phoneExits = await userModel.findOne({ phone });
      if (phoneExits)
      {
        return next(new ErrorHandler("Mobile already exist", 400));
      }
      if (existUser) {
        return next(new ErrorHandler("Email already exist", 400));
      }
      const user = await userModel.create({
        name,
        email,
        password,
        phone,
        location
      });
      const smsBody = `Dear ${name}, you have successfully registered.`;
      await sendSMS(smsBody, phone); 
      const whatsappBody = `Dear ${name}, you have successfully registered.`;
      await sendWhatsAppMessage(whatsappBody, phone);
      res.status(201).json({
        success: true,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// Login user
interface ILoginRequest {
  email: string;
  password: string;
}

export const loginUser = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as ILoginRequest;

      if (!email || !password) {
        return next(new ErrorHandler("Please enter email and password", 400));
      }

      const user = await userModel.findOne({ email }).select("+password");

      if (!user) {
        return next(new ErrorHandler("Invalid email or password", 400));
      }

      const isPasswordMatch = await user.comparePassword(password);
      if (!isPasswordMatch) {
        return next(new ErrorHandler("Invalid email or password", 400));
      }

      sendToken(user, 200, res);

    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


//Resend OTP


export const resendOtp = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;

      // Check if the user exists
      const user = await userModel.findOne({ email });
      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      // Create a new activation token
      const activationToken = createActivationToken({
        name: user.name,
        email: user.email,
        password: user.password,
      });

      const activationCode = activationToken.activationCode;

      // Send the new activation email
      const data = { user: { name: user.name }, activationCode };
      const html = await ejs.renderFile(
        path.join(__dirname, "../mails/activation-mail.ejs"),
        data
      );

      try {
        await sendMail({
          email: user.email,
          subject: "Resend OTP for Activate your account",
          template: "activation-mail.ejs",
          data,
        });

        res.status(200).json({
          success: true,
          message: `A new activation email has been sent to ${user.email}. Please check your email to activate your account.`,
          activationToken: activationToken.token,
          email: user.email, 
        });
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);
// logout user
export const logoutUser = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.cookie("access_token", "", { maxAge: 1 });
      res.cookie("refresh_token", "", { maxAge: 1 });
      const userId = req.user?._id || "";
      // console.log(req.user)
      redis.del(userId);
      res.status(200).json({
        success: true,
        message: "Logged out successfully",
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }

  
);

// update access token
// access token will expire soon (5m) but refresh token  expire (3d)
export const updateAccessToken = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refresh_token = req.cookies.refresh_token as string;
      const decoded = jwt.verify(
        refresh_token,
        process.env.REFRESH_TOKEN as string
      ) as JwtPayload;

      if (!decoded) {
        return next(new ErrorHandler("Could not refresh token", 400));
      }

      const session = await redis.get(decoded.id as string);
         
      if (!session) {
        return next(
          new ErrorHandler("Please login to access this resource!", 400)
        );
      }
      
      const user = JSON.parse(session);

      const accessToken = jwt.sign(
        { id: user._id },
        process.env.ACCESS_TOKEN as string,
        {
          expiresIn: "1440m",
        }
      );

      req.user = user;

      res.cookie("access_token", accessToken, { httpOnly: true, sameSite: 'lax' });

      await redis.set(user._id, JSON.stringify(user), "EX", 604800); // 7days

      return res.status(200).json({
        status: "Success",
        accessToken,
      });

    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


// get user info
// export const getUserInfo = CatchAsyncError(
//   async (req: Request, res: Response, next: NextFunction) => {
//     try {
//       const userId = req.user?._id;

//       if (!userId) {
//         return next(new ErrorHandler("User ID not found", 400));
//       }

//       getUserById(userId, res);
//     } catch (error: any) {
//       return next(new ErrorHandler(error.message, 400));
//     }
//   }
// );




interface UpdateProfileData {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
}

export const getUserProfileAndUpdate = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.params.userId;

      if (!userId) {
        return next(new ErrorHandler("User ID not found", 400));
      }

      // Clear the user data from Redis cache
      await redis.del(userId);

      // Fetch fresh data from the database
      let user = await userModel.findById(userId).select("-password");

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      // Check if there's any data to update
      const updateData: UpdateProfileData = {};
      if (req.body.name) updateData.name = req.body.name;
      if (req.body.email) updateData.email = req.body.email;
      if (req.body.phone) updateData.phone = req.body.phone;
      if (req.body.location) updateData.location = req.body.location;

      // If there's data to update, update the user
      if (Object.keys(updateData).length > 0) {
        user = await userModel.findByIdAndUpdate(
          userId,
          { $set: updateData },
          { new: true, runValidators: true }
        ).select("-password");

        if (!user) {
          return next(new ErrorHandler("User update failed", 400));
        }
      }

      // Update Redis cache with fresh data
      await redis.set(userId, JSON.stringify(user), "EX", 604800); // 7 days

      // Ensure all fields are included in the response, even if they're null or undefined
      res.status(200).json({
        success: true,
        user: {
          name: user.name || null,
          email: user.email || null,
          phone: user.phone || null,
          location: user.location || null,
        },
      });
    } catch (error: any) {
      console.error('Error:', error);
      return next(new ErrorHandler(error.message, 400));
    }
  }
);
export const getUserInfo = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("User ID not found", 400));
      }

      // Clear the user data from Redis cache
      await redis.del(userId.toString());

      // Fetch fresh data from the database
      const user = await userModel.findById(userId).select("-password");

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      // Update Redis cache with fresh data
      await redis.set(userId.toString(), JSON.stringify(user), "EX", 604800); // 7 days

      res.status(200).json({
        success: true,
        user,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);
export const clearUserCache = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("User ID not found", 400));
      }

      await redis.del(userId.toString());

      res.status(200).json({
        success: true,
        message: "User cache cleared successfully",
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);



// social auth

interface ISocialAuthBody {
  email: string;
  name: string;
  avatar: string;
}

export const socialAuth = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, name, avatar } = req.body as ISocialAuthBody;
      const user = await userModel.findOne({ email });
      if (!user) {
        const newUser = await userModel.create({ email, name, avatar });
        sendToken(newUser, 200, res);
      } else {
        sendToken(user, 200, res);
      }
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// update user info
interface IUpdateUserInfo {
  name?: string;
  email?: string;
}


export const updateUserInfo = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email } = req.body as IUpdateUserInfo;
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("User ID not found", 400));
      }

      const user = await userModel.findById(userId);

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      if (email) {
        const isEmailExist = await userModel.findOne({ email });
        if (isEmailExist) {
          return next(new ErrorHandler("Email Already Exists", 400));
        }
        user.email = email;
      }

      if (name) {
        user.name = name;
      }

      // Clear and update Redis cache
      await redis.del(userId.toString());
      await redis.set(userId.toString(), JSON.stringify(user), "EX", 604800);
        await user.save()

      await redis.set(userId, JSON.stringify(user));

      res.status(201).json({
        success: true,
        user,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


// update user password
interface IUpdatePassword {
  oldPassword: string;
  newPassword: string;
}

export const updatePassword = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { oldPassword, newPassword } = req.body as IUpdatePassword;

      if (!oldPassword || !newPassword) {
        return next(new ErrorHandler("Please enter old and new password", 400));
      }

      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("User ID not found", 400));
      }

      const user = await userModel.findById(userId).select("+password");

      if (!user || user.password === undefined) {
        return next(new ErrorHandler("Invalid user", 400));
      }

      const isPasswordMatch = await user.comparePassword(oldPassword);

      if (!isPasswordMatch) {
        return next(new ErrorHandler("Invalid old password", 400));
      }

      user.password = newPassword;

      await user.save();

      await redis.set(userId, JSON.stringify(user));

      res.status(201).json({
        success: true,
        user,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);



// update profile picture

interface IUpdateProfilePicture {
  avatar: string;
}

export const updateProfilePicture = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { avatar } = req.body as IUpdateProfilePicture;

      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("User ID not found", 400));
      }

      const user = await userModel.findById(userId).select("+password");

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      if (avatar) {
        // Delete the old avatar if it exists
        if (user.avatar?.public_id) {
          await cloudinary.v2.uploader.destroy(user.avatar.public_id);
        }

        // Upload the new avatar
        const myCloud = await cloudinary.v2.uploader.upload(avatar, {
          folder: "avatars",
          width: 150,
        });

        // Update user avatar information
        user.avatar = {
          public_id: myCloud.public_id,
          url: myCloud.secure_url,
        };

        await user.save();

        await redis.set(userId, JSON.stringify(user));
      }

      res.status(200).json({
        success: true,
        user,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


// get all users --- only for admin
export const getAllUsers = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      getAllUsersService(res);
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// update user role --- only for admin
export const updateUserRole = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, role } = req.body;
      const isUserExist = await userModel.findOne({ email });
      if (isUserExist) {
        const id = isUserExist._id;
        updateUserRoleService(res,id, role);
      } else {
        res.status(400).json({
          success: false,
          message: "User not found",
        });
      }
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// Delete user --- only for admin
export const deleteUser = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const user = await userModel.findById(id);

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      await user.deleteOne({ id });

      await redis.del(id);

      res.status(200).json({
        success: true,
        message: "User deleted successfully",
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// Reset Password - GET
export const getResetPassword = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id, token } = req.params;
    const oldUser: IUser | null = await userModel.findById(id);

    if (!oldUser) {
      return next(new ErrorHandler("User Not Exists", 404));
    }

    const verify = jwt.verify(token, process.env.ACTIVATION_SECRET as string) as { email: string };

    res.render("reset-password-mail", {
      userName: oldUser.name,
      email: verify.email,
      status: "Not Verified",
    });
  }
);

// Reset Password - POST
export const postResetPassword = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id, token } = req.params;
    const { password } = req.body;

    const oldUser: IUser | null = await userModel.findById(id);

    if (!oldUser) {
      return next(new ErrorHandler("User Not Exists", 404));
    }

    jwt.verify(token, process.env.ACTIVATION_SECRET as string);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await userModel.updateOne({ _id: id }, { $set: { password: hashedPassword } });

    res.render("reset-password-mail", {
      userName: oldUser.name,
      email: oldUser.email,
      status: "Verified",
    });
  }
);

//forget -password
export const forgetPassword = CatchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email } = req.body;
    const oldUser: IUser | null = await userModel.findOne({ email });

    if (!oldUser) {
      return next(new ErrorHandler("User Not Exists", 404));
    }

    const token = jwt.sign({ data: oldUser._id }, process.env.ACTIVATION_SECRET as string, {
      expiresIn: "1h",
    });

    // const link = `${process.env.BACKEND_URL}/api/v1/reset-password/${oldUser._id}/${token}`;
    const link = `http://localhost:8000/api/v1/reset-password/${oldUser._id}/${token}`;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_MAIL,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.SMTP_MAIL,
      to: email,
      subject: "Reset Your Password From SolviT",
      text: `Click the Link to Reset The Password \n${link}`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return next(new ErrorHandler(error.message, 500));
      } else {
        res.json({ msg: "Email sent: " + info.response });
      }
    });
  }
);


