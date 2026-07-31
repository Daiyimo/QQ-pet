
var $ISWEB = (function(){
		
		try{
			var count = window.external.LOG_GetLogCount();
			if(count == undefined){
				return true;
			}else{
				var qt = window.external.MF_ExecuteCommand("GetClientInfo", null);
				if(qt != undefined){
					return true;
				}
			}
			return false;
		}catch(ex){
			return true;
		}
		
})();

function closeFrame(){
	
	if($ISWEB){
		window.parent.PET.CloseMain();
	}else{
		window.close();
	}
}
function closeVip(){
	
	if($ISWEB){
		window.parent.PET.closeVip();
	}else{
		window.external.api_onvip_close();
	}
}
function closeSub(){

    if($ISWEB){
		window.parent.PET.CloseSub();
	}else{
		window.close();
	}
}
function closeMiddle(){
    if($ISWEB){
		window.parent.PET.CloseMid();
	}else{
		window.close();
	}
}
function openIE(url){
	if($ISWEB){
		if(!/^https?:/i.test(url)){console.warn('[backRoom] refuse non-http(s) url:',url);return;}
		var _win = window.open(url);
		if(_win == null || _win.closed){
          alert('您的浏览器启用弹出窗口过滤功能！\n\n请暂时先关闭此功能！');
		}
	}else{
		location.href = "pet://$IE$["+url+"]";
	}
}

function openVip(url){
	url = url || 'about:blank'; // 离线本地版：移除粉钻开通外链
	if($ISWEB){
		window.parent.PET.OpenVip(url);
	}else{
		location.href = "pet://$VIP$["+url+"]";
	}
}

function openSub(url){

	if($ISWEB){		
		window.parent.PET.OpenSub(url);
	}else{
		location.href = "pet://$SUB$["+url+"]";
	}
}

function openFrame(url){
	
	if($ISWEB){
		window.parent.PET.OpenMain(url);
	}else{
		location.href = "pet://$MAIN$["+url+"]";
	}
}

function openFlash(url){
	if($ISWEB){
		window.parent.PET.OpenFlashGame(url);
	}else{
		location.href="pet://$FLASHWEB$["+url+"]";
	}
}

function openMiddle(url){
	
	if($ISWEB){
		window.parent.PET.OpenMid(url);
	}else{
		location.href = "pet://$MIDDLE$["+url+"]";
	}
}
